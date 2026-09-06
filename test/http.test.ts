import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDemo, demoProject, DEMO_PASSWORD } from "../src/demo.js";
import { startServer } from "../src/server.js";
test("local API requires session token, exact origin and explicit run authorization; credentials remain private", async () => {
  const dir = mkdtempSync(join(tmpdir(), "launch-inspector-http-")),
    demo = await startDemo(0),
    app = await startServer({ dataDir: dir, port: 0, demoOrigin: demo.origin });
  try {
    const html = await (await fetch(app.origin)).text(),
      token = html.match(/name="inspector-token" content="([^"]+)"/)?.[1];
    assert(token && token !== "__INSPECTOR_TOKEN__");
    const headers = {
      "X-Inspector-Token": token,
      "Content-Type": "application/json",
    };
    assert.equal((await fetch(app.origin + "/api/state")).status, 403);
    assert.equal(
      (
        await fetch(app.origin + "/api/state", {
          headers: { ...headers, Origin: "https://evil.test" },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(app.origin + "/api/state", {
          headers: { ...headers, "Sec-Fetch-Site": "cross-site" },
        })
      ).status,
      403,
    );
    const response = await fetch(app.origin + "/api/projects", {
      method: "POST",
      headers,
      body: JSON.stringify(demoProject(demo.origin, "fixed")),
    });
    assert.equal(response.status, 201);
    const project = await response.json();
    assert.equal(project.accounts[0].password, "");
    const state = await (
      await fetch(app.origin + "/api/state", { headers })
    ).text();
    assert(!state.includes(DEMO_PASSWORD));
    assert.equal(
      (
        await fetch(app.origin + "/api/runs", {
          method: "POST",
          headers,
          body: JSON.stringify({ projectId: project.id, authorized: false }),
        })
      ).status,
      400,
    );
    assert.equal(app.store.listRuns().length, 0);
    assert.equal(
      (
        await fetch(app.origin + "/api/projects", {
          method: "POST",
          headers,
          body: JSON.stringify({
            ...demoProject(demo.origin, "fixed"),
            baseUrl: app.origin,
          }),
        })
      ).status,
      400,
    );
    assert.equal(
      (await fetch(app.origin + "/api/runs/not-a-uuid")).status,
      403,
    );
    assert.equal((await fetch(app.origin + "/master.key")).status, 404);
    assert.equal(
      (
        await fetch(app.origin + "/api/projects", {
          method: "POST",
          headers,
          body: "x".repeat(256001),
        })
      ).status,
      400,
    );
  } finally {
    await app.close();
    await demo.close();
    if (dir.startsWith(join(tmpdir(), "launch-inspector-http-")))
      rmSync(dir, { recursive: true, force: true });
  }
});
