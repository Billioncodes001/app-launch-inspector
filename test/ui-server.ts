import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDemo, demoProject } from "../src/demo.js";
import { startServer } from "../src/server.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { comparisonFixture } from "./fixtures/comparison.js";
const dir = mkdtempSync(join(tmpdir(), "launch-inspector-ui-"));
const demo = await startDemo(0);
const dependencySite = createServer((_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(
    '<!doctype html><html lang="en"><head><title>Controlled sign-in page</title></head><body><h1>Sign in</h1><label>Email<input type="email" value="synthetic@example.test"></label><img alt="Logo" src="https://assets.example.test/logo.svg?private-token=synthetic"></body></html>',
  );
});
await new Promise<void>((r) => dependencySite.listen(0, "127.0.0.1", r));
const app = await startServer({
  dataDir: dir,
  port: Number(process.env.INSPECTOR_UI_PORT || 8797),
  demoOrigin: demo.origin,
  stepTimeoutMs: 800,
});
// An old, completed synthetic record exercises actual retention deletion in UI.
const archive = app.store.saveProject({
  ...demoProject(demo.origin, "fixed"),
  name: "Archived synthetic inspection",
});
const archivedRun = app.store.createRun(app.store.getProject(archive.id));
comparisonFixture(app.store, demo.origin);
archivedRun.status = "completed";
archivedRun.createdAt = "2000-01-01T00:00:00.000Z";
app.store.saveRun(archivedRun);
app.store.database.sql
  .prepare("UPDATE runs SET created_at=? WHERE id=?")
  .run(archivedRun.createdAt, archivedRun.id);
const dependencyConfig = {
  ...demoProject(
    `http://127.0.0.1:${(dependencySite.address() as AddressInfo).port}`,
    "fixed",
  ),
  accounts: [],
  checks: [
    {
      kind: "page" as const,
      name: "Public page content",
      path: "/",
      expectedText: "Sign in",
    },
  ],
};
app.store.saveProject({
  ...dependencyConfig,
  name: "Dependency diagnostic sample",
});
const legacy = app.store.saveProject({
    ...dependencyConfig,
    name: "Earlier dependency report",
  }),
  legacyRun = app.store.createRun(app.store.getProject(legacy.id));
legacyRun.status = "completed";
legacyRun.results = [
  {
    index: 0,
    name: "Public page content",
    kind: "page",
    status: "inconclusive",
    severity: "info",
    summary: "Page content confirmed",
    expected: "The page shows Sign in.",
    observed: "Expected content is visible.",
    recommendation:
      "Resolve blocked dependencies and rerun this check before relying on it.",
    steps: ["Navigate to /"],
    durationMs: 100,
    screenshots: [],
    warnings: [
      "A request was blocked outside the target origin or request budget.",
    ],
  },
];
app.store.saveRun(legacyRun);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
  await demo.close();
  await new Promise<void>((r) => {
    dependencySite.close(() => r());
    dependencySite.closeAllConnections();
  });
  if (dir.startsWith(join(tmpdir(), "launch-inspector-ui-")))
    rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
console.log(app.origin);
