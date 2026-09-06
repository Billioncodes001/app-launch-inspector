import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDemo, demoProject } from "../src/demo.js";
import { startServer } from "../src/server.js";
const dir = mkdtempSync(join(tmpdir(), "launch-inspector-ui-"));
const demo = await startDemo(0);
const app = await startServer({
  dataDir: dir,
  port: 8797,
  demoOrigin: demo.origin,
  stepTimeoutMs: 800,
});
// An old, completed synthetic record exercises actual retention deletion in UI.
const archive = app.store.saveProject({
  ...demoProject(demo.origin, "fixed"),
  name: "Archived synthetic inspection",
});
const archivedRun = app.store.createRun(app.store.getProject(archive.id));
archivedRun.status = "completed";
archivedRun.createdAt = "2000-01-01T00:00:00.000Z";
app.store.saveRun(archivedRun);
app.store.database.sql
  .prepare("UPDATE runs SET created_at=? WHERE id=?")
  .run(archivedRun.createdAt, archivedRun.id);
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
