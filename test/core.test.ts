import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { demoProject, DEMO_PASSWORD } from "../src/demo.js";
import { projectSchema, pathSchema } from "../src/contracts.js";
import { allowedAddress, inScope, targetPolicy } from "../src/network.js";

test("configuration rejects escaping paths and ambiguous identity checks", () => {
  for (const path of ["//evil.test/a", "/\\evil.test/a", "https://evil.test/a"])
    assert.equal(pathSchema.safeParse(path).success, false);
  const p = demoProject("http://127.0.0.1:8787", "broken");
  assert.equal(
    projectSchema.safeParse({ ...p, baseUrl: "http://user:secret@example.com" })
      .success,
    false,
  );
  assert.equal(
    projectSchema.safeParse({ ...p, accounts: [p.accounts[0], p.accounts[0]] })
      .success,
    false,
  );
  assert.equal(
    projectSchema.safeParse({
      ...p,
      checks: [
        {
          kind: "access",
          name: "Bad",
          owner: "owner",
          actor: "owner",
          path: "/admin",
          expectedText: "Secret",
          deniedText: "Denied",
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    projectSchema.safeParse({
      ...p,
      checks: [
        {
          kind: "journey",
          name: "Empty promise",
          account: "",
          steps: [{ action: "visit", path: "/" }],
        },
      ],
    }).success,
    false,
  );
});
test("network policy rejects private destinations, metadata, credentials and its control port", async () => {
  for (const address of [
    "10.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.5",
    "0.0.0.0",
    "100.100.100.200",
    "224.0.0.1",
    "fc00::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
    "2002:7f00:1::1",
  ])
    assert.equal(allowedAddress(address), false, address);
  assert.equal(allowedAddress("127.0.0.1"), true);
  assert.equal(allowedAddress("2606:4700:4700::1111"), true);
  assert.equal(
    inScope("http://127.0.0.1:1234/a", "http://127.0.0.1:1234"),
    true,
  );
  assert.equal(
    inScope("http://127.0.0.1:1235/a", "http://127.0.0.1:1234"),
    false,
  );
  await assert.rejects(targetPolicy("http://169.254.169.254"));
  await assert.rejects(targetPolicy("http://127.0.0.1:8795", [8795]));
  await assert.rejects(targetPolicy("http://localhost:8795", [8795]));
});
test("configuration encryption, secret retention, authentication and interrupted-run recovery", () => {
  const dir = mkdtempSync(join(tmpdir(), "launch-inspector-core-"));
  const store = new Store(dir);
  try {
    const publicProject = store.saveProject(
      demoProject("http://127.0.0.1:8787", "broken"),
    );
    assert(
      !String(
        store.database.sql.prepare("SELECT data FROM projects").get()?.data,
      ).includes(DEMO_PASSWORD),
    );
    assert.equal(publicProject.accounts[0].password, "");
    assert.equal(publicProject.accounts[0].passwordConfigured, true);
    const input = demoProject("http://127.0.0.1:8787", "broken");
    input.accounts.forEach((a) => (a.password = ""));
    store.saveProject(input, publicProject.id);
    const reopened = new Store(dir);
    const project = reopened.getProject(publicProject.id);
    reopened.close();
    assert.equal(project.accounts[0].password, DEMO_PASSWORD);
    const run = store.createRun(project);
    run.status = "running";
    store.saveRun(run);
    store.recover();
    assert.equal(store.getRun(run.id).status, "interrupted");
    assert.equal(store.database.verifyAudit("local").valid, true);
    const encoded = JSON.parse(
      String(
        store.database.sql.prepare("SELECT data FROM projects").get()?.data,
      ),
    );
    encoded.tag = Buffer.alloc(16).toString("base64");
    store.database.sql
      .prepare("UPDATE projects SET data=?")
      .run(JSON.stringify(encoded));
    assert.throws(() => store.listProjects());
    assert.throws(() => store.runDir("../../secrets"));
  } finally {
    store.close();
    if (dir.startsWith(join(tmpdir(), "launch-inspector-core-")))
      rmSync(dir, { recursive: true, force: true });
  }
});
