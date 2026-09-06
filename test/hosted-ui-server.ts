import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDemo, demoProject } from "../src/demo.js";
import { startServer } from "../src/server.js";
import { localActor } from "../src/database.js";
import { oidcFixture } from "./fixtures/oidc.js";
const dir = mkdtempSync(join(tmpdir(), "launch-inspector-hosted-ui-")),
  provider = await oidcFixture(),
  demo = await startDemo(0);
const app = await startServer({
  dataDir: dir,
  port: 8798,
  publicOrigin: "http://127.0.0.1:8798",
  mode: "hosted",
  oidc: provider.settings,
  allowLoopbackTargetsForTests: true,
  browserSandbox: false,
  stepTimeoutMs: 1000,
});
const a = app.access.createOrganization(
    "Northstar Labs",
    "owner-a@example.test",
    [demo.origin],
  ),
  b = app.access.createOrganization("Harbor Systems", "owner-b@example.test", [
    demo.origin,
  ]);
for (const org of [a, b]) {
  const proof = app.targets.challenge(org.id, demo.origin, 0, localActor);
  demo.publishVerification(proof.value!);
  await app.targets.verify(
    org.id,
    demo.origin,
    proof.version,
    "https",
    localActor,
  );
}
const ap = app.store.scope(a.id).saveProject({
  ...demoProject(demo.origin, "broken"),
  name: "Northstar staging",
});
const config = demoProject(demo.origin, "fixed");
config.checks = [config.checks[0]];
app.store
  .scope(b.id)
  .saveProject({ ...config, name: "Harbor customer portal" });
app.access.saveMember(
  a.id,
  {
    email: "viewer-a@example.test",
    role: "viewer",
    projectIds: [ap.id],
    version: 0,
  },
  localActor,
);
app.access.saveMember(
  b.id,
  { email: "owner-a@example.test", role: "viewer", projectIds: [], version: 0 },
  localActor,
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await app.close();
  await provider.close();
  await demo.close();
  if (dir.startsWith(join(tmpdir(), "launch-inspector-hosted-ui-")))
    rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
console.log(app.origin);
