import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { randomUUID, randomBytes, createCipheriv } from "node:crypto";
import { Store } from "../src/store.js";
import { Access } from "../src/access.js";
import { localActor } from "../src/database.js";
import { startServer } from "../src/server.js";
import { startDemo, demoProject, DEMO_PASSWORD } from "../src/demo.js";
import { BrowserCapacity } from "../src/capacity.js";
import { oidcFixture, signIn, beginLogin } from "./fixtures/oidc.js";
import { targetPolicy } from "../src/network.js";

async function port() {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const value = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return value;
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "launch-inspector-hosted-")),
    provider = await oidcFixture(),
    demo = await startDemo(0),
    servicePort = await port();
  const app = await startServer({
    dataDir: dir,
    port: servicePort,
    publicOrigin: `http://127.0.0.1:${servicePort}`,
    mode: "hosted",
    oidc: provider.settings,
    allowLoopbackTargetsForTests: true,
    browserSandbox: false,
    stepTimeoutMs: 1500,
  });
  const a = app.access.createOrganization(
      "Northstar Labs",
      "owner-a@example.test",
      [demo.origin],
    ),
    b = app.access.createOrganization(
      "Harbor Systems",
      "owner-b@example.test",
      [demo.origin],
    );
  const as = app.store.scope(a.id),
    bs = app.store.scope(b.id);
  const config = demoProject(demo.origin, "fixed");
  config.checks = [config.checks[0]];
  const ap = as.saveProject({ ...config, name: "Northstar project" }),
    hidden = as.saveProject({
      ...config,
      name: "Northstar restricted project",
    }),
    bp = bs.saveProject({ ...config, name: "Harbor private project" });
  app.access.saveMember(
    a.id,
    {
      email: "viewer-a@example.test",
      role: "viewer",
      projectIds: [ap.id],
      version: 0,
    },
    localActor,
  );
  app.access.saveMember(
    a.id,
    {
      email: "editor-a@example.test",
      role: "editor",
      projectIds: [ap.id],
      version: 0,
    },
    localActor,
  );
  const close = async () => {
    await app.close();
    await demo.close();
    await provider.close();
    if (dir.startsWith(join(tmpdir(), "launch-inspector-hosted-")))
      rmSync(dir, { recursive: true, force: true });
  };
  return { app, provider, demo, a, b, as, bs, ap, bp, hidden, close };
}

test("real OIDC sessions isolate companies, enforce project roles and revoke access immediately", async () => {
  const f = await fixture();
  try {
    const { app, a, b, as, bs, ap, bp, hidden } = f;
    assert.equal((await fetch(app.origin + "/api/state")).status, 401);
    const ownerA = await signIn(app.origin, "owner-a@example.test"),
      ownerB = await signIn(app.origin, "owner-b@example.test"),
      viewer = await signIn(app.origin, "viewer-a@example.test"),
      editor = await signIn(app.origin, "editor-a@example.test");
    const state = await (
      await fetch(app.origin + "/api/state", { headers: ownerA.headers })
    ).json();
    assert.equal(state.projects.length, 2);
    assert(!JSON.stringify(state).includes("Harbor"));
    assert(!JSON.stringify(state).includes(DEMO_PASSWORD));
    assert.equal(
      (
        await fetch(app.origin + "/api/state", {
          headers: { ...ownerA.headers, "X-Inspector-Organization": b.id },
        })
      ).status,
      403,
    );
    const viewState = await (
      await fetch(app.origin + "/api/state", { headers: viewer.headers })
    ).json();
    assert.deepEqual(
      viewState.projects.map((p: { id: string }) => p.id),
      [ap.id],
    );
    assert.equal(viewState.projects[0].accounts[0].username, "");
    const update = async (
      headers: Record<string, string>,
      id: string,
      input = demoProject(f.demo.origin, "fixed"),
      revision = ap.revision,
    ) =>
      fetch(app.origin + "/api/projects/" + id, {
        method: "PUT",
        headers: { ...headers, "If-Match": '"' + revision + '"' },
        body: JSON.stringify(input),
      });
    assert.equal((await update(viewer.headers, ap.id)).status, 403);
    assert.equal((await update(editor.headers, hidden.id)).status, 404);
    assert.equal((await update(ownerA.headers, bp.id)).status, 404);
    const started = await fetch(app.origin + "/api/runs", {
      method: "POST",
      headers: ownerA.headers,
      body: JSON.stringify({
        projectId: ap.id,
        revision: ap.revision,
        authorized: true,
      }),
    });
    assert.equal(started.status, 202, await started.clone().text());
    const runId = (await started.json()).id;
    for (
      let i = 0;
      i < 200 && ["queued", "running"].includes(as.getRun(runId).status);
      i++
    )
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(as.getRun(runId).results[0].status, "passed");
    const ar = as.getRun(runId),
      evidence = ar.results[0].screenshots[0].file;
    for (const suffix of ["", "/export?format=json", "/evidence/" + evidence])
      assert.equal(
        (
          await fetch(app.origin + "/api/runs/" + runId + suffix, {
            headers: ownerB.headers,
          })
        ).status,
        404,
      );
    const br = bs.createRun(bs.getProject(bp.id));
    assert.equal(
      (
        await fetch(app.origin + "/api/runs/" + br.id + "/cancel", {
          method: "POST",
          headers: ownerA.headers,
          body: "{}",
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await fetch(app.origin + "/api/runs", {
          method: "POST",
          headers: viewer.headers,
          body: JSON.stringify({
            projectId: ap.id,
            revision: ap.revision,
            authorized: true,
          }),
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(app.origin + "/api/members", { headers: editor.headers }))
        .status,
      403,
    );
    assert.equal(
      (await fetch(app.origin + "/api/audit", { headers: viewer.headers }))
        .status,
      403,
    );
    assert.equal(
      (
        await fetch(app.origin + "/api/state", {
          headers: { ...ownerA.headers, "X-Inspector-Token": "wrong" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(app.origin + "/api/state", {
          headers: { ...ownerA.headers, Origin: "https://other.example" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(app.origin + "/api/demo", {
          method: "POST",
          headers: ownerA.headers,
          body: JSON.stringify({ variant: "broken" }),
        })
      ).status,
      404,
    );
    const revocation = await fetch(app.origin + "/api/members", {
      method: "DELETE",
      headers: ownerA.headers,
      body: JSON.stringify({ email: "viewer-a@example.test", version: 1 }),
    });
    assert.equal(revocation.status, 200);
    assert.equal(
      (await fetch(app.origin + "/api/state", { headers: viewer.headers }))
        .status,
      403,
    );
    assert.equal(
      (
        await fetch(app.origin + "/api/members", {
          method: "DELETE",
          headers: ownerA.headers,
          body: JSON.stringify({ email: "owner-a@example.test", version: 1 }),
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await fetch(app.origin + "/api/logout", {
          method: "POST",
          headers: ownerA.headers,
          body: "{}",
        })
      ).status,
      200,
    );
    assert.equal(
      (await fetch(app.origin + "/api/state", { headers: ownerA.headers }))
        .status,
      401,
    );
    assert.equal(app.store.database.verifyAudit(a.id).valid, true);
  } finally {
    await f.close();
  }
});

test("OIDC rejects callback substitution, replay, unapproved identity and invalid signed tokens", async () => {
  const f = await fixture();
  try {
    const { app, provider } = f;
    const started = await beginLogin(app.origin, "owner-a@example.test");
    assert.equal(
      (await fetch(started.callback, { redirect: "manual" })).status,
      400,
    );
    assert.equal(
      (
        await fetch(started.callback, {
          headers: { Cookie: "inspector_flow=wrong" },
          redirect: "manual",
        })
      ).status,
      400,
    );
    const accepted = await fetch(started.callback, {
      headers: { Cookie: started.flowCookie },
      redirect: "manual",
    });
    assert.equal(accepted.status, 303);
    assert(
      accepted.headers
        .getSetCookie()
        .some((v) => v.includes("HttpOnly") && v.includes("SameSite=Lax")),
    );
    assert.equal(
      (
        await fetch(started.callback, {
          headers: { Cookie: started.flowCookie },
          redirect: "manual",
        })
      ).status,
      400,
    );
    for (const email of [
      "unapproved@example.test",
      "unverified@example.test",
    ]) {
      const flow = await beginLogin(app.origin, email);
      assert.equal(
        (
          await fetch(flow.callback, {
            headers: { Cookie: flow.flowCookie },
            redirect: "manual",
          })
        ).status,
        403,
      );
    }
    for (const fault of [
      "signature",
      "issuer",
      "audience",
      "nonce",
      "expired",
    ]) {
      provider.fault(fault);
      const flow = await beginLogin(app.origin, "owner-a@example.test");
      const rejected = await fetch(flow.callback, {
        headers: { Cookie: flow.flowCookie },
        redirect: "manual",
      });
      assert.notEqual(rejected.status, 303, fault);
      assert(
        !rejected.headers
          .getSetCookie()
          .some((v) => v.startsWith("inspector_session=")),
        fault,
      );
    }
    const session = await signIn(app.origin, "owner-a@example.test");
    app.store.database.sql
      .prepare("UPDATE sessions SET seen=?")
      .run(Date.now() - 1800001);
    assert.equal(
      (await fetch(app.origin + "/api/state", { headers: session.headers }))
        .status,
      401,
    );
  } finally {
    await f.close();
  }
});

test("configuration revisions, review decisions and audit integrity survive conflicting requests", async () => {
  const f = await fixture();
  try {
    const { app, as, ap, a } = f,
      owner = await signIn(app.origin, "owner-a@example.test"),
      editor = await signIn(app.origin, "editor-a@example.test");
    const config = demoProject(f.demo.origin, "fixed");
    const update = (headers: Record<string, string>) =>
      fetch(app.origin + "/api/projects/" + ap.id, {
        method: "PUT",
        headers,
        body: JSON.stringify(config),
      });
    assert.equal((await update(owner.headers)).status, 428);
    const revisionHeaders = {
      ...owner.headers,
      "If-Match": '"' + ap.revision + '"',
    };
    assert.equal((await update(revisionHeaders)).status, 200);
    assert.equal((await update(revisionHeaders)).status, 409);
    assert.equal(
      (
        await fetch(app.origin + "/api/runs", {
          method: "POST",
          headers: owner.headers,
          body: JSON.stringify({
            projectId: ap.id,
            revision: ap.revision,
            authorized: true,
          }),
        })
      ).status,
      409,
    );
    const run = as.createRun(as.getProject(ap.id));
    run.status = "completed";
    run.results = [
      {
        index: 0,
        name: "Observed permission leak",
        kind: "access",
        status: "failed",
        severity: "high",
        summary: "Private data visible",
        expected: "Denied",
        observed: "Visible",
        recommendation: "Fix authorization",
        steps: ["Load resource"],
        durationMs: 1,
        warnings: [],
        screenshots: [],
      },
    ];
    as.saveRun(run);
    const review = (
      headers: Record<string, string>,
      status: string,
      version: number,
    ) =>
      fetch(app.origin + `/api/runs/${run.id}/reviews/0`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          status,
          note: "Documented temporary exception with a tracked remediation task.",
          version,
        }),
      });
    assert.equal(
      (await review(editor.headers, "accepted_risk", 0)).status,
      403,
    );
    assert.equal((await review(owner.headers, "accepted_risk", 0)).status, 200);
    assert.equal((await review(owner.headers, "investigating", 0)).status, 409);
    assert.equal(as.getRun(run.id).results[0].status, "failed");
    const md = await (
      await fetch(app.origin + `/api/runs/${run.id}/export?format=md`, {
        headers: owner.headers,
      })
    ).text();
    assert(md.includes("Review decisions"));
    assert(md.includes("accepted risk"));
    assert.equal(app.store.database.verifyAudit(a.id).valid, true);
    const count = app.store.database.auditEntries(a.id).length;
    assert.throws(() =>
      app.store.database.transaction(() => {
        app.store.database.audit(a.id, localActor, "should.rollback");
        throw Error("Abort transaction");
      }),
    );
    assert.equal(app.store.database.auditEntries(a.id).length, count);
    app.store.database.sql
      .prepare(
        "UPDATE audit SET details='{}' WHERE organization_id=? AND action='finding.accepted_risk'",
      )
      .run(a.id);
    assert.equal(app.store.database.verifyAudit(a.id).valid, false);
  } finally {
    await f.close();
  }
});

test("hosted target policy and shared capacity fail closed", async () => {
  await assert.rejects(
    targetPolicy("http://127.0.0.1:9000", [], false),
    /loopback/,
  );
  await assert.rejects(targetPolicy("https://169.254.169.254", [], false));
  const capacity = new BrowserCapacity(1, 2),
    release1 = capacity.reserve(),
    release2 = capacity.reserve();
  assert.throws(() => capacity.reserve(), /capacity/);
  const first = await capacity.acquire(new AbortController().signal),
    abort = new AbortController();
  const waiting = capacity.acquire(abort.signal);
  abort.abort();
  await assert.rejects(waiting, /cancelled/);
  first();
  release1();
  release2();
  assert.deepEqual(capacity.snapshot(), {
    active: 0,
    pending: 0,
    maxActive: 1,
    maxPending: 2,
  });
});

test("legacy local data migrates transactionally without changing files or leaking into organizations", () => {
  const dir = mkdtempSync(join(tmpdir(), "launch-inspector-migration-")),
    key = randomBytes(32),
    iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  const project = {
    ...demoProject("http://127.0.0.1:8796", "broken"),
    id: randomUUID(),
    revision: randomUUID(),
    updatedAt: new Date().toISOString(),
  };
  const data = Buffer.concat([
    cipher.update(JSON.stringify([project])),
    cipher.final(),
  ]);
  const legacy = JSON.stringify({
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  });
  writeFileSync(join(dir, "master.key"), key);
  writeFileSync(join(dir, "projects.enc"), legacy);
  const runId = randomUUID();
  mkdirSync(join(dir, "runs", runId), { recursive: true });
  writeFileSync(
    join(dir, "runs", runId, "run.json"),
    JSON.stringify({
      id: runId,
      projectId: project.id,
      projectName: project.name,
      projectRevision: project.revision,
      target: project.baseUrl,
      repository: "",
      status: "running",
      createdAt: new Date().toISOString(),
      authorizedAt: new Date().toISOString(),
      total: 6,
      results: [],
    }),
  );
  const store = new Store(dir);
  try {
    assert.equal(
      store.getProject(project.id).accounts[0].password,
      DEMO_PASSWORD,
    );
    store.recover();
    assert.equal(store.getRun(runId).status, "interrupted");
    assert.equal(readFileSync(join(dir, "projects.enc"), "utf8"), legacy);
    const org = new Access(store.database).createOrganization(
      "Separate company",
      "owner-a@example.test",
      [project.baseUrl],
    );
    assert.equal(store.scope(org.id).listProjects().length, 0);
    assert.throws(() => store.scope(org.id).getRun(runId));
    const encrypted = String(
      store.database.sql
        .prepare("SELECT data FROM projects WHERE id=?")
        .get(project.id)?.data,
    );
    assert.throws(() =>
      store.database.decrypt(org.id + ":project:" + project.id, encrypted),
    );
  } finally {
    store.close();
    if (dir.startsWith(join(tmpdir(), "launch-inspector-migration-")))
      rmSync(dir, { recursive: true, force: true });
  }
});
