import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Store } from "../src/store.js";
import { Runner } from "../src/runner.js";
import { demoProject } from "../src/demo.js";

test("network diagnostics distinguish request-budget exhaustion and bound destination details", async () => {
  const site = createServer((req, res) => {
    if (req.url?.startsWith("/asset")) {
      res.writeHead(204);
      res.end();
      return;
    }
    const many = req.url === "/many",
      urls = Array.from({ length: many ? 20 : 260 }, (_, i) =>
        many
          ? `https://asset-${i}.example.test/private-path?credential=do-not-record`
          : `/asset?item=${i}`,
      );
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<!doctype html><html><body><script>Promise.all(${JSON.stringify(urls)}.map(u=>fetch(u).catch(()=>null))).then(()=>{document.body.innerHTML='<h1>Requests settled</h1>';});</script></body></html>`,
    );
  });
  await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
  const root = mkdtempSync(join(tmpdir(), "inspector-diagnostics-")),
    store = new Store(root),
    runner = new Runner(store, 8795, { stepTimeoutMs: 10000 });
  try {
    const input = demoProject(
      `http://127.0.0.1:${(site.address() as AddressInfo).port}`,
      "fixed",
    );
    input.accounts = [];
    input.checks = [
      {
        kind: "page",
        name: "Bounded requests",
        path: "/budget",
        expectedText: "Requests settled",
      },
      {
        kind: "page",
        name: "Many external origins",
        path: "/many",
        expectedText: "Requests settled",
      },
    ];
    const saved = store.saveProject(input),
      run = await runner.enqueue(store.getProject(saved.id));
    const deadline = Date.now() + 45000;
    let result = store.getRun(run.id);
    while (
      ["queued", "running"].includes(result.status) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 50));
      result = store.getRun(run.id);
    }
    assert.equal(result.status, "completed", result.error);
    assert.deepEqual(
      result.results.map((r) => r.status),
      ["inconclusive", "inconclusive"],
    );
    const [budget, many] = result.results;
    assert(budget.network!.blocked >= 11);
    assert(
      budget.network!.destinations.every((d) => d.reason === "request_budget"),
    );
    assert(budget.recommendation.includes("250 requests"));
    assert.equal(many.network!.blocked, 20);
    assert.equal(many.network!.destinations.length, 16);
    assert.equal(many.network!.truncated, true);
    assert(!JSON.stringify(result).includes("private-path"));
    assert(!JSON.stringify(result).includes("do-not-record"));
  } finally {
    await runner.close();
    store.close();
    await new Promise<void>((r) => {
      site.close(() => r());
      site.closeAllConnections();
    });
    if (root.startsWith(join(tmpdir(), "inspector-diagnostics-")))
      rmSync(root, { recursive: true, force: true });
  }
});
