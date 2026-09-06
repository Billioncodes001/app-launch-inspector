import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  rmdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store.js";
import { Access } from "../src/access.js";
import { Targets } from "../src/targets.js";
import { Retention } from "../src/retention.js";
import { localActor } from "../src/database.js";
import { demoProject } from "../src/demo.js";

test("ownership proof rejects wrong company, redirects, oversized responses, expired and changed challenges; renewal requires live proof", async () => {
  const root = mkdtempSync(join(tmpdir(), "inspector-proofs-")),
    store = new Store(root),
    access = new Access(store.database);
  let value = "",
    status = 200;
  const server = createServer((_req, res) => {
    res.writeHead(status, {
      "Content-Type": "text/plain",
      Location: "/redirect",
    });
    res.end(value);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const a = access.createOrganization("Proof A", "a@example.test", [origin]),
    b = access.createOrganization("Proof B", "b@example.test", [origin]);
  const targets = new Targets(access, true);
  try {
    assert.throws(
      () => targets.assertVerified(a.id, origin),
      /Verify this target/,
    );
    let pa = targets.challenge(a.id, origin, 0, localActor);
    const pb = targets.challenge(b.id, origin, 0, localActor);
    value = pb.value!;
    await assert.rejects(
      targets.verify(a.id, origin, pa.version, "https", localActor),
      /does not match/,
    );
    value = pa.value!;
    status = 302;
    await assert.rejects(
      targets.verify(a.id, origin, pa.version, "https", localActor),
      /redirects/,
    );
    status = 200;
    value = "x".repeat(4097);
    await assert.rejects(
      targets.verify(a.id, origin, pa.version, "https", localActor),
      /4 KB/,
    );
    value = pa.value!;
    await assert.rejects(
      targets.verify(a.id, origin, pa.version, "https", localActor, () => {
        throw Error("Owner revoked");
      }),
      /Owner revoked/,
    );
    assert.throws(() => targets.assertVerified(a.id, origin));
    await assert.rejects(
      targets.verify(a.id, origin, pa.version, "https", localActor, () =>
        targets.challenge(a.id, origin, pa.version, localActor),
      ),
      /changed during/,
    );
    pa = targets.list(a.id)[0];
    value = pa.value!;
    const verified = await targets.verify(
      a.id,
      origin,
      pa.version,
      "https",
      localActor,
    );
    targets.assertVerified(a.id, origin);
    assert.equal(verified.status, "verified");
    assert.throws(() => targets.assertVerified(b.id, origin));
    store.database.sql
      .prepare(
        "UPDATE target_proofs SET verified_until=? WHERE organization_id=?",
      )
      .run("2000-01-01T00:00:00.000Z", a.id);
    assert.throws(() => targets.assertVerified(a.id, origin));
    value = "removed";
    await assert.rejects(
      targets.verify(a.id, origin, verified.version, "https", localActor),
      /does not match/,
    );
    value = pa.value!;
    await targets.verify(a.id, origin, verified.version, "https", localActor);
    store.database.sql
      .prepare("UPDATE target_proofs SET issued_at=? WHERE organization_id=?")
      .run("2000-01-01T00:00:00.000Z", b.id);
    await assert.rejects(
      targets.verify(b.id, origin, pb.version, "https", localActor),
      /expired/,
    );
    await assert.rejects(
      new Targets(access).verify(
        a.id,
        origin,
        targets.list(a.id)[0].version,
        "https",
        localActor,
      ),
      /public|private|loopback/i,
    );
    assert.equal(store.database.verifyAudit(a.id).valid, true);
  } finally {
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
    store.close();
    if (root.startsWith(join(tmpdir(), "inspector-proofs-")))
      rmSync(root, { recursive: true, force: true });
  }
});

test("retention previews are scoped, reject changed evidence and preserve holds; durable file cleanup retries and policy is opt-in", () => {
  const root = mkdtempSync(join(tmpdir(), "inspector-retention-")),
    store = new Store(root),
    access = new Access(store.database),
    retention = new Retention(store);
  const a = access.createOrganization("Retention A", "a@example.test", [
      "https://example.com",
    ]),
    b = access.createOrganization("Retention B", "b@example.test", [
      "https://example.com",
    ]);
  function seed(org: string, status: "completed" | "running" = "completed") {
    const scoped = store.scope(org),
      p = scoped.saveProject(demoProject("https://example.com", "fixed")),
      run = scoped.createRun(scoped.getProject(p.id));
    run.status = status;
    run.createdAt = "2000-01-01T00:00:00.000Z";
    scoped.saveRun(run);
    store.database.sql
      .prepare("UPDATE runs SET created_at=? WHERE organization_id=? AND id=?")
      .run(run.createdAt, org, run.id);
    writeFileSync(join(scoped.runDir(run.id), "0-0.png"), "synthetic evidence");
    return run;
  }
  try {
    const first = seed(a.id),
      held = seed(a.id),
      active = seed(a.id, "running"),
      other = seed(b.id);
    retention.sweep();
    assert(store.scope(a.id).getRun(first.id));
    assert.equal(retention.policy(a.id).days, 0);
    retention.hold(a.id, held.id, "Preserve for customer review", localActor);
    assert.throws(
      () => retention.hold(a.id, active.id, "Preserve active run", localActor),
      /finish/,
    );
    const preview = retention.preview(a.id, 30, localActor);
    assert.equal(preview.count, 1);
    assert.equal(preview.held, 1);
    assert(preview.bytes > 0);
    assert.throws(
      () => retention.execute(b.id, preview.token, localActor),
      /not valid/,
    );
    assert.throws(
      () =>
        retention.execute(a.id, preview.token, {
          ...localActor,
          id: "another-owner",
        }),
      /not valid/,
    );
    retention.hold(a.id, first.id, "New preservation request", localActor);
    assert.throws(
      () => retention.execute(a.id, preview.token, localActor),
      /changed|hold/,
    );
    retention.hold(a.id, first.id, null, localActor);
    const fresh = retention.preview(a.id, 30, localActor),
      dir = store.scope(a.id).runDir(first.id);
    mkdirSync(join(dir, "unexpected-directory")); // Simulate a storage anomaly after preview.
    const result = retention.execute(a.id, fresh.token, localActor);
    assert.equal(result.deleted, 1);
    assert.equal(result.pendingFiles, 1);
    assert.throws(() => store.scope(a.id).getRun(first.id), /not found/);
    assert(existsSync(dir));
    rmdirSync(join(dir, "unexpected-directory"));
    retention.cleanup();
    assert.equal(retention.pending(a.id), 0);
    assert.equal(existsSync(dir), false);
    assert.throws(
      () => retention.execute(a.id, fresh.token, localActor),
      /changed/,
    );
    assert(store.scope(a.id).getRun(held.id).hold);
    assert(store.scope(a.id).getRun(active.id));
    assert(store.scope(b.id).getRun(other.id));
    const eligible = seed(a.id);
    retention.savePolicy(a.id, 7, 0, localActor);
    assert.throws(
      () => retention.savePolicy(a.id, 14, 0, localActor),
      /changed/,
    );
    retention.sweep();
    assert.throws(() => store.scope(a.id).getRun(eligible.id), /not found/);
    assert(store.scope(a.id).getRun(held.id));
    assert.equal(store.database.verifyAudit(a.id).valid, true);
  } finally {
    store.close();
    if (root.startsWith(join(tmpdir(), "inspector-retention-")))
      rmSync(root, { recursive: true, force: true });
  }
});
