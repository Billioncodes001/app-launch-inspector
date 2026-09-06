import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDemo } from "../src/demo.js";
import { startServer } from "../src/server.js";
const dir = mkdtempSync(join(tmpdir(), "launch-inspector-ui-"));
const demo = await startDemo(0);
const app = await startServer({
  dataDir: dir,
  port: 8797,
  demoOrigin: demo.origin,
  stepTimeoutMs: 800,
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
  await demo.close();
  if (dir.startsWith(join(tmpdir(), "launch-inspector-ui-")))
    rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
console.log(app.origin);
