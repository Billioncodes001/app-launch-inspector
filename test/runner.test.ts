import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store.js";
import { Runner, reportMarkdown } from "../src/runner.js";
import { startDemo, demoProject, DEMO_PASSWORD } from "../src/demo.js";
async function settled(store: Store, id: string) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const run = store.getRun(id);
    if (!["queued", "running"].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("Run did not complete");
}
test("real browser finds four seeded failures; corrected application passes all six checks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "launch-inspector-browser-")),
    demo = await startDemo(0),
    store = new Store(dir),
    runner = new Runner(store, 8795, { stepTimeoutMs: 650 });
  try {
    const broken = store.saveProject(demoProject(demo.origin, "broken")),
      fixed = store.saveProject(demoProject(demo.origin, "fixed"));
    const before = await settled(
      store,
      (await runner.enqueue(store.getProject(broken.id))).id,
    );
    assert.equal(before.status, "completed", before.error);
    assert.equal(before.results.length, 6);
    assert.deepEqual(
      before.results.map((r) => r.status),
      ["passed", "passed", "failed", "failed", "failed", "failed"],
    );
    assert(before.results.every((r) => r.screenshots.length > 0));
    assert.equal(before.results[4].screenshots.length, 2);
    assert(
      before.results[4].steps.some((s) =>
        s.includes("Authorized baseline confirmed"),
      ),
    );
    assert(!JSON.stringify(before).includes(DEMO_PASSWORD));
    assert(!reportMarkdown(before).includes(DEMO_PASSWORD));
    const after = await settled(
      store,
      (await runner.enqueue(store.getProject(fixed.id))).id,
    );
    assert.equal(after.status, "completed", after.error);
    assert.deepEqual(
      after.results.map((r) => r.status),
      Array(6).fill("passed"),
      JSON.stringify(after.results.map((r) => r.observed)),
    );
  } finally {
    await runner.close();
    await demo.close();
    if (dir.startsWith(join(tmpdir(), "launch-inspector-browser-"))) {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
test("failed authorized baseline is inconclusive and does not certify a permission boundary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "launch-inspector-baseline-")),
    demo = await startDemo(0),
    store = new Store(dir),
    runner = new Runner(store, 8795, { stepTimeoutMs: 2000 });
  try {
    const p = demoProject(demo.origin, "fixed");
    p.checks = [p.checks[2]];
    p.login.successText = "A marker which does not exist";
    const saved = store.saveProject(p),
      run = await settled(
        store,
        (await runner.enqueue(store.getProject(saved.id))).id,
      );
    assert.equal(run.results[0].status, "inconclusive");
    assert(!run.results[0].steps.some((s) => s.includes("restricted")));
  } finally {
    await runner.close();
    await demo.close();
    if (dir.startsWith(join(tmpdir(), "launch-inspector-baseline-"))) {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
test("out-of-scope browser requests are blocked and prevent a clean pass", async () => {
  let contacted = 0;
  const external = createServer((_, res) => {
    contacted++;
    res.end("outside");
  });
  await new Promise<void>((r) => external.listen(0, "127.0.0.1", r));
  const outside = `http://127.0.0.1:${(external.address() as AddressInfo).port}`;
  const site = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/login") {
      req.resume();
      res.writeHead(303, { Location: "/account" });
      res.end();
      return;
    }
    res.setHeader("Content-Type", "text/html");
    const form =
      req.url === "/login"
        ? '<form method="post"><label>Email<input name="email"></label><label>Password<input name="password" type="password"></label><button>Sign in</button></form>'
        : "";
    res.end(
      `<html><body><h1>Ready</h1>${form}<img src="${outside}/secret"></body></html>`,
    );
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "launch-inspector-scope-")),
    store = new Store(dir),
    runner = new Runner(store, 8795, { stepTimeoutMs: 2000 });
  try {
    const p = demoProject(
      `http://127.0.0.1:${(site.address() as AddressInfo).port}`,
      "fixed",
    );
    p.login.path = "/login";
    p.login.successPath = "/account";
    p.login.successText = "Ready";
    p.checks = [
      { kind: "page", name: "Scoped page", path: "/", expectedText: "Ready" },
      {
        kind: "page",
        name: "Missing content with a blocked dependency",
        path: "/",
        expectedText: "Rendered by the blocked dependency",
      },
      {
        kind: "access",
        name: "A blocked dependency does not excuse visible unauthorized content",
        path: "/protected",
        owner: "admin",
        actor: "anonymous",
        expectedText: "Ready",
        deniedText: "Access denied",
      },
    ];
    const saved = store.saveProject(p),
      run = await settled(
        store,
        (await runner.enqueue(store.getProject(saved.id))).id,
      );
    assert.equal(contacted, 0);
    assert.deepEqual(
      run.results.map((result) => result.status),
      ["inconclusive", "inconclusive", "failed"],
      JSON.stringify(run.results),
    );
    assert(run.results.every((result) => result.warnings.length > 0));
  } finally {
    await runner.close();
    site.closeAllConnections();
    external.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => site.close(() => r())),
      new Promise<void>((r) => external.close(() => r())),
    ]);
    if (dir.startsWith(join(tmpdir(), "launch-inspector-scope-"))) {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
test("queued cancellation, active cancellation and shutdown do not replay actions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "launch-inspector-cancel-")),
    demo = await startDemo(0),
    store = new Store(dir),
    runner = new Runner(store, 8795, { stepTimeoutMs: 15000 });
  try {
    const p = demoProject(demo.origin, "fixed");
    p.checks = [
      {
        kind: "page",
        name: "Wait",
        path: "/fixed/",
        expectedText: "Never appears",
      },
    ];
    const saved = store.saveProject(p);
    const first = await runner.enqueue(store.getProject(saved.id)),
      second = await runner.enqueue(store.getProject(saved.id));
    await runner.cancel(second.id);
    assert.equal(store.getRun(second.id).status, "cancelled");
    await runner.cancel(first.id);
    await runner.close();
    assert.equal(store.getRun(first.id).status, "cancelled");
    assert.equal(store.getRun(second.id).results.length, 0);
  } finally {
    await runner.close();
    await demo.close();
    if (dir.startsWith(join(tmpdir(), "launch-inspector-cancel-"))) {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
