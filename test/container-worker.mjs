import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { startWorker } from "../dist/worker-server.js";
import { startDemo } from "../dist/demo.js";
assert.notEqual(process.getuid(), 0);
assert(
  !existsSync("/data/master.key"),
  "Worker must not mount controller data",
);
assert(
  !process.env.INSPECTOR_OIDC_CLIENT_SECRET,
  "Worker must not receive the OIDC secret",
);
// Browser diagnostics are safe here: this application only has synthetic data.
const browser = await chromium.launch({
  channel: "chromium",
  headless: true,
  chromiumSandbox: true,
});
await browser.close();
const demo = await startDemo(8800);
const worker = await startWorker({
  host: "0.0.0.0",
  port: 8799,
  token: process.env.INSPECTOR_WORKER_TOKEN,
  allowLoopbackForTests: true,
});
console.log("Synthetic worker ready; sandbox enabled; controller data absent");
process.on("SIGTERM", async () => {
  await worker.close();
  await demo.close();
  process.exit(0);
});
