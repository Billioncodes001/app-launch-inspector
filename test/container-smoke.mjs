import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../dist/store.js";
import { Runner } from "../dist/runner.js";
import { startDemo, demoProject } from "../dist/demo.js";
import { chromium } from "playwright";
assert.notEqual(process.getuid(), 0, "Container must run as a non-root user");
// Surface full launch diagnostics in this synthetic fixture before the runner's
// intentionally bounded, redacted error report is involved.
const browser = await chromium.launch({
  channel: "chromium",
  headless: true,
  chromiumSandbox: true,
});
await browser.close();
const dir = mkdtempSync(join(tmpdir(), "inspector-container-"));
const store = new Store(dir),
  demo = await startDemo(0);
const runner = new Runner(store, 8795, { sandbox: true, stepTimeoutMs: 1500 });
try {
  for (const mode of ["broken", "fixed"]) {
    const saved = store.saveProject(demoProject(demo.origin, mode));
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
  await demo.close();
  store.close();
  if (dir.startsWith(join(tmpdir(), "inspector-container-")))
    rmSync(dir, { recursive: true, force: true });
}
