import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir, hostname } from "node:os";
import { Store } from "../src/store.js";
import { Access } from "../src/access.js";
import { demoProject, DEMO_PASSWORD } from "../src/demo.js";
import {
  acquireLease,
  createBackup,
  verifyBackup,
  restoreBackup,
} from "../src/operations.js";

test("service lease excludes a second instance and maintenance, and recovers a stale container lease", () => {
  const root = mkdtempSync(join(tmpdir(), "inspector-lease-"));
  const first = new Store(join(root, "data")),
    second = new Store(join(root, "data"));
  let lease = acquireLease(first.database);
  try {
    assert.throws(() => acquireLease(second.database), /in use/);
    assert.throws(
      () => createBackup(join(root, "data"), join(root, "backup")),
      /in use/,
    );
    assert.equal(existsSync(join(root, "backup")), false);
    lease.release();
    lease = acquireLease(second.database);
    assert.equal(lease.active, true);
    lease.release();
    first.database.sql
      .prepare("INSERT INTO metadata VALUES('service_lease',?)")
      .run(
        JSON.stringify({
          token: "stale",
          hostname: hostname() + "-old-container",
          pid: 1,
          until: Date.now() + 90000,
        }),
      );
    assert.throws(() => acquireLease(second.database), /90 seconds/);
    first.database.sql
      .prepare("UPDATE metadata SET value=? WHERE key='service_lease'")
      .run(
        JSON.stringify({
          token: "stale",
          hostname: hostname() + "-old-container",
          pid: 1,
          until: 0,
        }),
      );
    lease = acquireLease(second.database);
    assert.equal(lease.active, true);
  } finally {
    lease.release();
    first.close();
    second.close();
    if (root.startsWith(join(tmpdir(), "inspector-lease-")))
      rmSync(root, { recursive: true, force: true });
  }
});

test("offline backup restores encrypted organization records and evidence while revoking sessions; damaged or escaping backups fail", () => {
  const root = mkdtempSync(join(tmpdir(), "inspector-restore-"));
  const source = join(root, "data"),
    snapshot = join(root, "snapshot"),
    target = join(root, "restored");
  const store = new Store(source),
    access = new Access(store.database);
  const org = access.createOrganization(
    "Recovery customer",
    "owner@example.test",
    ["http://127.0.0.1:9999"],
  );
  const scoped = store.scope(org.id);
  const project = scoped.saveProject(
    demoProject("http://127.0.0.1:9999", "fixed"),
  );
  const run = scoped.createRun(scoped.getProject(project.id));
  writeFileSync(join(scoped.runDir(run.id), "0-0.png"), "synthetic-evidence");
  assert.throws(() => createBackup(source, snapshot), /interrupted runs/);
  run.status = "completed";
  scoped.saveRun(run);
  store.database.sql
    .prepare("INSERT INTO sessions VALUES(?,?,?,?,?)")
    .run("hash", "{}", "csrf", Date.now(), Date.now());
  store.database.sql
    .prepare("INSERT INTO auth_transactions VALUES(?,?,?,?)")
    .run("hash", "cookiehash", "{}", Date.now());
  store.close();
  try {
    const result = createBackup(source, snapshot);
    assert.equal(result.files, 3);
    assert.equal(verifyBackup(snapshot).files.length, 3);
    assert.throws(() => createBackup(source, snapshot), /new backup directory/);
    assert.throws(() => restoreBackup(snapshot, source), /non-existing/);
    assert.throws(
      () => restoreBackup(snapshot, join(snapshot, "nested")),
      /outside/,
    );
    assert.equal(restoreBackup(snapshot, target).sessionsRevoked, true);
    const restored = new Store(target);
    try {
      const customer = restored.scope(org.id);
      assert.equal(
        customer.getProject(project.id).accounts[0].password,
        DEMO_PASSWORD,
      );
      assert.equal(customer.getRun(run.id).status, "completed");
      assert.equal(
        readFileSync(join(customer.runDir(run.id), "0-0.png"), "utf8"),
        "synthetic-evidence",
      );
      assert.equal(
        restored.database.sql
          .prepare("SELECT count(*) AS n FROM sessions")
          .get()?.n,
        0,
      );
      assert.equal(
        restored.database.sql
          .prepare("SELECT count(*) AS n FROM auth_transactions")
          .get()?.n,
        0,
      );
      assert.equal(
        restored.database.sql
          .prepare("SELECT value FROM metadata WHERE key='service_lease'")
          .get(),
        undefined,
      );
      assert.equal(restored.database.verifyAudit(org.id).valid, true);
      assert.equal(
        restored.database.auditEntries(org.id)[0].action,
        "backup.restored",
      );
      assert.throws(() => restored.getProject(project.id));
    } finally {
      restored.close();
    }
    const manifestPath = join(snapshot, "manifest.json"),
      originalManifest = readFileSync(manifestPath, "utf8");
    const manifest = JSON.parse(originalManifest);
    manifest.files.push({ path: "../escape", bytes: 0, sha256: "" });
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => verifyBackup(snapshot), /Unsafe backup path/);
    writeFileSync(manifestPath, originalManifest);
    writeFileSync(join(snapshot, "master.key"), "damaged");
    assert.throws(
      () => restoreBackup(snapshot, join(root, "bad")),
      /checksum mismatch/,
    );
    assert.equal(existsSync(join(root, "bad")), false);
  } finally {
    if (root.startsWith(join(tmpdir(), "inspector-restore-")))
      rmSync(root, { recursive: true, force: true });
  }
});
