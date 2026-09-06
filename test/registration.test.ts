import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { startServer } from "../src/server.js";
import { oidcFixture, signIn, beginLogin } from "./fixtures/oidc.js";
import { demoProject } from "../src/demo.js";
import { Store } from "../src/store.js";
import { Access } from "../src/access.js";

async function fixture(signupEnabled = true) {
  const dir = mkdtempSync(join(tmpdir(), "inspector-registration-"));
  const provider = await oidcFixture();
  const listener = createServer();
  await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>((r) => listener.close(() => r()));
  const app = await startServer({
    dataDir: dir,
    port,
    mode: "hosted",
    publicOrigin: `http://127.0.0.1:${port}`,
    oidc: provider.settings,
    signupEnabled,
    allowLoopbackTargetsForTests: true,
    browserSandbox: false,
  });
  return {
    app,
    provider,
    close: async () => {
      await app.close();
      await provider.close();
      if (dir.startsWith(join(tmpdir(), "inspector-registration-")))
        rmSync(dir, { recursive: true, force: true });
    },
  };
}
const organizationInput = () => ({
  name: "New customer",
  requestedOrigin: "https://staging.example.com",
  requestId: randomUUID(),
});
async function call(
  origin: string,
  headers: Record<string, string>,
  path: string,
  method = "GET",
  body?: unknown,
) {
  return fetch(origin + "/api" + path, {
    headers,
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("verified signup creates an isolated owner workspace, is idempotent and respects CSRF and quotas", async () => {
  const f = await fixture();
  try {
    const { app } = f;
    assert.equal((await fetch(app.origin + "/signup")).status, 200);
    const owner = await signIn(app.origin, "new-owner@example.test");
    assert.equal(owner.session.authenticated, true);
    assert.deepEqual(owner.session.organizations, []);
    const input = organizationInput();
    assert.equal(
      (await call(app.origin, {}, "/organizations", "POST", input)).status,
      401,
    );
    assert.equal(
      (
        await call(
          app.origin,
          { ...owner.headers, "X-Inspector-Token": "wrong" },
          "/organizations",
          "POST",
          input,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          app.origin,
          { ...owner.headers, Origin: "https://other.example" },
          "/organizations",
          "POST",
          input,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(app.origin, owner.headers, "/organizations", "POST", {
          ...input,
          role: "owner",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await call(app.origin, owner.headers, "/organizations", "POST", {
          ...input,
          requestedOrigin: "https://target.example/path",
        })
      ).status,
      400,
    );
    const responses = await Promise.all(
      [1, 2].map(() =>
        call(app.origin, owner.headers, "/organizations", "POST", input),
      ),
    );
    assert.deepEqual(
      responses.map((r) => r.status),
      [201, 201],
    );
    const [org, replay] = await Promise.all(responses.map((r) => r.json()));
    assert.equal(org.id, replay.id);
    assert.deepEqual(org.origins, []);
    assert.equal(app.access.members(org.id)[0].role, "owner");
    assert.equal(app.access.members(org.id)[0].activated, true);
    const ownHeaders = { ...owner.headers, "X-Inspector-Organization": org.id };
    const state = await (await call(app.origin, ownHeaders, "/state")).json();
    assert.deepEqual(state.projects, []);
    assert.equal(state.registration.requestedOrigin, input.requestedOrigin);
    assert.deepEqual(state.approvedOrigins, []);
    const another = await signIn(app.origin, "owner-b@example.test");
    assert.equal(
      (
        await call(
          app.origin,
          { ...another.headers, "X-Inspector-Organization": org.id },
          "/state",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(app.origin, ownHeaders, "/targets/challenge", "POST", {
          origin: input.requestedOrigin,
          version: 0,
        })
      ).status,
      403,
    );
    app.registration.approveTarget(org.id, input.requestedOrigin);
    assert.deepEqual(app.access.organization(org.id).origins, [
      input.requestedOrigin,
    ]);
    assert.equal(app.store.database.verifyAudit(org.id).valid, true);
    for (let i = 0; i < 2; i++)
      assert.equal(
        (
          await call(
            app.origin,
            owner.headers,
            "/organizations",
            "POST",
            organizationInput(),
          )
        ).status,
        201,
      );
    assert.equal(
      (
        await call(
          app.origin,
          owner.headers,
          "/organizations",
          "POST",
          organizationInput(),
        )
      ).status,
      409,
    );
  } finally {
    await f.close();
  }
});

test("invite-only deployments admit verified invitees without granting membership before acceptance", async () => {
  const f = await fixture(false);
  try {
    const { app } = f;
    const org = app.access.createOrganization(
      "Northstar",
      "owner-a@example.test",
      ["https://staging.example.com"],
    );
    const owner = await signIn(app.origin, "owner-a@example.test");
    const otherOrg = app.access.createOrganization(
      "Harbor",
      "owner-b@example.test",
      ["https://harbor.example.com"],
    );
    const other = await signIn(app.origin, "owner-b@example.test");
    const config = demoProject("https://staging.example.com", "fixed");
    const project = app.store.scope(org.id).saveProject(config);
    const bad = await beginLogin(app.origin, "unapproved@example.test");
    assert.equal(
      (
        await fetch(bad.callback, {
          headers: { Cookie: bad.flowCookie },
          redirect: "manual",
        })
      ).status,
      403,
    );
    const raw = {
      email: "new-reviewer@example.test",
      role: "viewer",
      projectIds: [project.id],
    };
    const response = await call(
      app.origin,
      owner.headers,
      "/invitations",
      "POST",
      raw,
    );
    assert.equal(response.status, 201);
    const invite = await response.json();
    assert.equal(app.access.members(org.id).length, 1);
    assert.equal(
      (await call(app.origin, owner.headers, "/invitations", "POST", raw))
        .status,
      409,
    );
    assert.equal(
      (
        await call(app.origin, other.headers, "/invitations", "DELETE", {
          id: invite.id,
        })
      ).status,
      404,
    );
    const reviewer = await signIn(app.origin, "new-reviewer@example.test");
    assert.deepEqual(reviewer.session.organizations, []);
    assert.equal(
      (
        await call(
          app.origin,
          reviewer.headers,
          "/organizations",
          "POST",
          organizationInput(),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          app.origin,
          { ...reviewer.headers, "X-Inspector-Organization": org.id },
          "/state",
        )
      ).status,
      403,
    );
    assert.deepEqual(
      (await (await call(app.origin, other.headers, "/account")).json())
        .invitations,
      [],
    );
    assert.equal(
      (
        await call(
          app.origin,
          other.headers,
          "/account/accept-invitation",
          "POST",
          { id: invite.id },
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await call(
          app.origin,
          reviewer.headers,
          "/account/accept-invitation",
          "POST",
          { id: invite.id, role: "owner" },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await call(
          app.origin,
          reviewer.headers,
          "/account/accept-invitation",
          "POST",
          { id: invite.id },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          app.origin,
          reviewer.headers,
          "/account/accept-invitation",
          "POST",
          { id: invite.id },
        )
      ).status,
      404,
    );
    const scope = { ...reviewer.headers, "X-Inspector-Organization": org.id };
    assert.equal((await call(app.origin, scope, "/state")).status, 200);
    assert.equal(
      (
        await call(app.origin, scope, "/invitations", "POST", {
          ...raw,
          email: "third@example.test",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          app.origin,
          { ...scope, "X-Inspector-Organization": otherOrg.id },
          "/state",
        )
      ).status,
      403,
    );
    const member = app.access
      .members(org.id)
      .find((m) => m.email === raw.email)!;
    assert.equal(member.role, "viewer");
    assert.deepEqual(member.projectIds, [project.id]);
    assert.equal(
      (
        await call(app.origin, owner.headers, "/members", "DELETE", {
          email: raw.email,
          version: member.version,
        })
      ).status,
      200,
    );
    assert.equal((await call(app.origin, scope, "/state")).status, 403);
    assert.equal(app.store.database.verifyAudit(org.id).valid, true);
  } finally {
    await f.close();
  }
});

test("expired, revoked and no-longer-authorized invitations cannot grant access; unverified signup fails", async () => {
  const f = await fixture();
  try {
    const { app } = f;
    const org = app.access.createOrganization(
      "Northstar",
      "owner-a@example.test",
      ["https://staging.example.com"],
    );
    const owner = await signIn(app.origin, "owner-a@example.test");
    const reviewer = await signIn(app.origin, "new-reviewer@example.test");
    const invite = async () =>
      (
        await call(app.origin, owner.headers, "/invitations", "POST", {
          email: reviewer.session.user.email,
          role: "viewer",
          projectIds: [],
        })
      ).json();
    const expired = await invite();
    app.store.database.sql
      .prepare("UPDATE invitations SET expires_at=? WHERE id=?")
      .run(Date.now() - 1, expired.id);
    assert.equal(
      (
        await call(
          app.origin,
          reviewer.headers,
          "/account/accept-invitation",
          "POST",
          { id: expired.id },
        )
      ).status,
      404,
    );
    const revoked = await invite();
    assert.equal(
      (
        await call(app.origin, owner.headers, "/invitations", "DELETE", {
          id: revoked.id,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          app.origin,
          reviewer.headers,
          "/account/accept-invitation",
          "POST",
          { id: revoked.id },
        )
      ).status,
      404,
    );
    const stale = await invite();
    app.store.database.sql
      .prepare("UPDATE members SET role='viewer' WHERE organization_id=?")
      .run(org.id);
    assert.equal(
      (
        await call(
          app.origin,
          reviewer.headers,
          "/account/accept-invitation",
          "POST",
          { id: stale.id },
        )
      ).status,
      409,
    );
    const bad = await beginLogin(app.origin, "unverified@example.test");
    assert.equal(
      (
        await fetch(bad.callback, {
          headers: { Cookie: bad.flowCookie },
          redirect: "manual",
        })
      ).status,
      403,
    );
    assert.equal(
      app.store.database.sql
        .prepare("SELECT 1 FROM accounts WHERE email='unverified@example.test'")
        .get(),
      undefined,
    );
  } finally {
    await f.close();
  }
});

test("account session revocation is scoped to the current identity and preserves the active session", async () => {
  const f = await fixture();
  try {
    const first = await signIn(f.app.origin, "new-owner@example.test");
    const second = await signIn(f.app.origin, "new-owner@example.test");
    const other = await signIn(f.app.origin, "owner-b@example.test");
    assert.equal(
      (
        await (
          await call(
            f.app.origin,
            second.headers,
            "/account/revoke-sessions",
            "POST",
            {},
          )
        ).json()
      ).revoked,
      1,
    );
    assert.equal(
      (await call(f.app.origin, first.headers, "/account")).status,
      401,
    );
    assert.equal(
      (await call(f.app.origin, second.headers, "/account")).status,
      200,
    );
    assert.equal(
      (await call(f.app.origin, other.headers, "/account")).status,
      200,
    );
  } finally {
    await f.close();
  }
});

test("schema 3 upgrades preserve existing organizations and identity bindings", () => {
  const dir = mkdtempSync(join(tmpdir(), "inspector-registration-migrate-"));
  let store = new Store(dir);
  try {
    const access = new Access(store.database);
    const org = access.createOrganization(
      "Existing customer",
      "owner-a@example.test",
      ["https://staging.example.com"],
    );
    const actor = access.identity(
      "https://id.example",
      "fixed-subject",
      "owner-a@example.test",
      true,
      "Existing owner",
    );
    store.database.sql.exec(
      "DROP TABLE organization_registrations; DROP TABLE invitations; DROP TABLE accounts; PRAGMA user_version=3;",
    );
    store.close();
    store = new Store(dir);
    const restored = new Access(store.database);
    assert.equal(
      restored.identity(
        "https://id.example",
        "fixed-subject",
        "owner-a@example.test",
        true,
        "Existing owner",
      ).id,
      actor.id,
    );
    assert.equal(restored.member(actor, org.id).role, "owner");
    assert.equal(
      store.database.sql.prepare("PRAGMA user_version").get()?.user_version,
      4,
    );
    assert.equal(store.database.verifyAudit(org.id).valid, true);
  } finally {
    store.close();
    if (dir.startsWith(join(tmpdir(), "inspector-registration-migrate-")))
      rmSync(dir, { recursive: true, force: true });
  }
});
