import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { compareRuns, compatibleRuns } from "../src/comparison.js";
import { comparisonFixture } from "./fixtures/comparison.js";
import { startServer } from "../src/server.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Runner } from "../src/runner.js";
import { demoProject } from "../src/demo.js";

test("comparison is deterministic, preserves evidence and never resolves unknown observations", () => {
  const root = mkdtempSync(join(tmpdir(), "inspector-comparison-")),
    store = new Store(root);
  try {
    const { before, after } = comparisonFixture(store),
      original = JSON.stringify([before, after]);
    const comparison = compareRuns(before, after);
    assert.deepEqual(comparison.counts, {
      new: 1,
      resolved: 1,
      persistent: 1,
      unchanged: 0,
      unverified: 3,
    });
    assert.equal(comparison.checks[5].to, "missing");
    assert.equal(JSON.stringify([before, after]), original);
    for (const from of ["passed", "failed", "skipped", "inconclusive"] as const)
      for (const to of [
        "passed",
        "failed",
        "skipped",
        "inconclusive",
      ] as const) {
        const a = structuredClone(before),
          b = structuredClone(after);
        a.results[0].status = from;
        b.results[0].status = to;
        const change = compareRuns(a, b).checks[0].change;
        assert.equal(
          change === "resolved",
          from === "failed" && to === "passed",
        );
        assert.equal(change === "new", from === "passed" && to === "failed");
      }
    const reviewed = structuredClone(before);
    reviewed.review = {
      "0": {
        status: "accepted_risk",
        note: "Synthetic accepted risk",
        actor: "owner",
        updatedAt: before.createdAt,
        version: 1,
      },
    };
    assert.deepEqual(compareRuns(reviewed, after), comparison);
    assert.deepEqual(
      compareRuns(before, { ...after, status: "interrupted" }).counts,
      comparison.counts,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("comparison rejects changed targets, revisions, identities, malformed indices and unfinished runs", () => {
  const root = mkdtempSync(join(tmpdir(), "inspector-comparison-")),
    store = new Store(root);
  try {
    const { before, after } = comparisonFixture(store);
    for (const change of [
      { target: "http://different.test" },
      { projectRevision: "other" },
      { projectRevision: "" },
      { projectId: "other" },
      { total: 7 },
      { status: "running" as const },
      { createdAt: "2000-01-01" },
      { results: [after.results[0], after.results[0]] },
      { results: [{ ...after.results[0], index: 99 }] },
      { results: [{ ...after.results[0], name: "different check" }] },
    ])
      assert.throws(() => compareRuns(before, { ...after, ...change }));
    assert.throws(() => compareRuns(before, before));
    const tied = { ...after, createdAt: before.createdAt };
    assert.equal(compatibleRuns(before, tied), false);
    assert.equal(compatibleRuns(tied, before), false);
    assert.throws(() => compareRuns(before, tied));
    assert.throws(() => compareRuns(tied, before));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("comparison API protects both runs, exports originals and handles unavailable evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "inspector-comparison-api-"));
  const app = await startServer({ dataDir: root, port: 0 });
  try {
    const { before, after } = comparisonFixture(app.store);
    const html = await (await fetch(app.origin)).text();
    const headers = {
      "X-Inspector-Token": html.match(
        /name="inspector-token" content="([^"]+)"/,
      )![1],
    };
    const url = `${app.origin}/api/runs/${before.id}/compare/${after.id}`;
    assert.equal((await fetch(url)).status, 403);
    const response = await fetch(url + "?export=json", { headers });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-disposition")!, /attachment/);
    const packet = await response.json();
    assert.deepEqual(
      packet.originalRuns.map((r: { results: unknown }) => r.results),
      [before.results, after.results],
    );
    assert(!JSON.stringify(packet).includes("password"));
    assert.equal(
      (
        await fetch(
          `${app.origin}/api/runs/${before.id}/compare/${before.id}`,
          { headers },
        )
      ).status,
      409,
    );
    app.store.database.sql
      .prepare("DELETE FROM runs WHERE id=?")
      .run(before.id);
    assert.equal((await fetch(url, { headers })).status, 404);
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("two real browser runs compare a fix without changing configuration or original screenshots", async () => {
  const root = mkdtempSync(join(tmpdir(), "inspector-comparison-browser-")),
    store = new Store(root);
  let fixed = false;
  const site = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<html><body><h1>${fixed ? "Synthetic ready marker" : "Synthetic pending marker"}</h1></body></html>`,
    );
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const runner = new Runner(store, 5311, { stepTimeoutMs: 500 });
  try {
    const project = store.saveProject({
      ...demoProject(
        `http://127.0.0.1:${(site.address() as AddressInfo).port}`,
        "fixed",
      ),
      accounts: [],
      checks: [
        {
          kind: "page",
          name: "Synthetic release marker",
          path: "/",
          expectedText: "Synthetic ready marker",
        },
      ],
    });
    const config = store.getProject(project.id);
    async function execute() {
      const run = await runner.enqueue(config);
      const deadline = Date.now() + 15000;
      while (
        ["queued", "running"].includes(store.getRun(run.id).status) &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      const saved = store.getRun(run.id);
      assert.equal(saved.status, "completed", saved.error);
      return saved;
    }
    const before = await execute(),
      original = JSON.stringify(before.results);
    fixed = true;
    const after = await execute();
    assert.equal(compareRuns(before, after).counts.resolved, 1);
    assert.equal(JSON.stringify(store.getRun(before.id).results), original);
    assert.equal(before.results[0].screenshots.length, 1);
    assert.equal(after.results[0].screenshots.length, 1);
  } finally {
    await runner.close();
    store.close();
    await new Promise<void>((resolve) => site.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
