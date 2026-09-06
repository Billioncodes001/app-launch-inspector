import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../dist/store.js";
import { Runner } from "../dist/runner.js";
import { demoProject } from "../dist/demo.js";
assert.notEqual(process.getuid(), 0, "Container must run as a non-root user");
const dir = mkdtempSync(join(tmpdir(), "inspector-container-"));
const store = new Store(dir);
const runner = new Runner(store, 8795, {
  sandbox: true,
  stepTimeoutMs: 1500,
  worker: {
    url: "http://worker:8799",
    token: process.env.INSPECTOR_WORKER_TOKEN,
  },
});
try {
  for (const mode of ["broken", "fixed"]) {
    const saved = store.saveProject(demoProject("http://127.0.0.1:8800", mode));
    const run = await runner.enqueue(store.getProject(saved.id));
    const deadline = Date.now() + 90000;
    let current;
    do {
      await new Promise((r) => setTimeout(r, 100));
      current = store.getRun(run.id);
    } while (
      ["queued", "running"].includes(current.status) &&
      Date.now() < deadline
    );
    assert.equal(current.status, "completed", current.error);
    assert.deepEqual(
      current.results.map((r) => r.status),
      mode === "broken"
        ? ["passed", "passed", "failed", "failed", "failed", "failed"]
        : Array(6).fill("passed"),
      JSON.stringify(current),
    );
    assert(current.results.every((r) => r.screenshots.length));
    console.log(
      JSON.stringify({
        sandbox: true,
        user: process.getuid(),
        sample: mode,
        results: current.results.map((r) => r.status),
      }),
    );
  }
} finally {
  await runner.close();
  store.close();
  if (dir.startsWith(join(tmpdir(), "inspector-container-")))
    rmSync(dir, { recursive: true, force: true });
}
