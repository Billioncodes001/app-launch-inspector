import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { startWorker } from "../src/worker-server.js";
import {
  executeInspection,
  parseEvents,
  validateWorkerConnection,
} from "../src/worker-client.js";
import { browserEnvironment, type WorkerJob } from "../src/worker-protocol.js";
import { startDemo, demoProject } from "../src/demo.js";
const token = "synthetic-worker-token-with-32-characters";

test("an unavailable browser channel cannot claim worker readiness", async () => {
  const original = process.env.PLAYWRIGHT_CHANNEL;
  process.env.PLAYWRIGHT_CHANNEL = "unavailable-fixture-channel";
  const worker = await startWorker({ port: 0, token, sandboxForTests: false });
  try {
    assert.equal(
      (
        await fetch(worker.origin + "/healthz", {
          headers: { Authorization: "Bearer " + token },
        })
      ).status,
      503,
    );
  } finally {
    if (original === undefined) delete process.env.PLAYWRIGHT_CHANNEL;
    else process.env.PLAYWRIGHT_CHANNEL = original;
    await worker.close();
  }
});

test("remote worker authenticates, runs a real browser, streams evidence and cleans its job directory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-remote-")),
    demo = await startDemo(0),
    worker = await startWorker({
      port: 0,
      token,
      allowLoopbackForTests: true,
      sandboxForTests: false,
    });
  const prior = new Set(
    readdirSync(tmpdir()).filter((n) => n.startsWith("inspector-job-")),
  );
  try {
    assert.equal((await fetch(worker.origin + "/healthz")).status, 401);
    assert.equal(
      (
        await fetch(worker.origin + "/healthz", {
          headers: { Authorization: "Bearer " + token },
        })
      ).status,
      200,
    );
    const project = demoProject(demo.origin, "fixed");
    project.checks = project.checks.slice(0, 2);
    const results: unknown[] = [];
    await executeInspection(
      {
        project,
        runId: randomUUID(),
        forbiddenPorts: [],
        allowLoopback: true,
        sandbox: false,
        stepTimeoutMs: 1000,
      },
      {
        directory,
        connection: { url: worker.origin, token },
        signal: AbortSignal.timeout(20000),
        onResult: (r) => results.push(r),
      },
    );
    assert.equal(results.length, 2);
    assert(
      readdirSync(directory).filter((n) => n.endsWith(".png")).length >= 2,
    );
    assert.deepEqual(
      readdirSync(tmpdir()).filter(
        (n) => n.startsWith("inspector-job-") && !prior.has(n),
      ),
      [],
    );
    process.env.INSPECTOR_OIDC_CLIENT_SECRET = "private-fixture";
    process.env.INSPECTOR_WORKER_TOKEN = token;
    const environment = browserEnvironment();
    assert(!("INSPECTOR_OIDC_CLIENT_SECRET" in environment));
    assert(!("INSPECTOR_WORKER_TOKEN" in environment));
  } finally {
    delete process.env.INSPECTOR_OIDC_CLIENT_SECRET;
    delete process.env.INSPECTOR_WORKER_TOKEN;
    await worker.close();
    await demo.close();
    if (directory.startsWith(join(tmpdir(), "inspector-remote-")))
      rmSync(directory, { recursive: true, force: true });
  }
});

test("worker enforces its own target boundary and abort never reports a partial run as complete", async () => {
  const demo = await startDemo(0),
    strict = await startWorker({ port: 0, token }),
    directory = mkdtempSync(join(tmpdir(), "inspector-worker-fail-"));
  const project = demoProject(demo.origin, "fixed"),
    job: WorkerJob = {
      project,
      runId: randomUUID(),
      allowLoopback: true,
      forbiddenPorts: [],
      sandbox: false,
      stepTimeoutMs: 1000,
    };
  try {
    const response = await fetch(strict.origin + "/jobs", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(job),
    });
    assert.equal(response.status, 400);
    const worker = await startWorker({
      port: 0,
      token,
      allowLoopbackForTests: true,
      sandboxForTests: false,
    });
    try {
      await assert.rejects(
        executeInspection(job, {
          directory,
          connection: { url: worker.origin, token },
          signal: AbortSignal.timeout(20),
          onResult: () => assert.fail("Cancelled before result"),
        }),
      );
    } finally {
      await worker.close();
    }
    assert(!existsSync(join(directory, "0-0.png")));
  } finally {
    await strict.close();
    await demo.close();
    if (directory.startsWith(join(tmpdir(), "inspector-worker-fail-")))
      rmSync(directory, { recursive: true, force: true });
  }
});

test("controller rejects incomplete, forged and oversized worker protocol responses", async () => {
  const directory = mkdtempSync(join(tmpdir(), "inspector-protocol-"));
  let output = '{"type":"done"}\n';
  const server = createServer((_req, res) => res.end(output));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const connection = {
    url: "http://127.0.0.1:" + (server.address() as AddressInfo).port,
    token,
  };
  const job: WorkerJob = {
    project: demoProject("https://example.com", "fixed"),
    runId: randomUUID(),
    allowLoopback: false,
    sandbox: true,
    forbiddenPorts: [],
    stepTimeoutMs: 1000,
  };
  try {
    await assert.rejects(
      executeInspection(job, {
        directory,
        connection,
        signal: AbortSignal.timeout(2000),
        onResult: () => assert.fail(),
      }),
      /omitted/,
    );
    output = '{"type":"done"}';
    await assert.rejects(
      executeInspection(job, {
        directory,
        connection,
        signal: AbortSignal.timeout(2000),
        onResult: () => assert.fail(),
      }),
      /incomplete/,
    );
    output = "";
    await assert.rejects(
      executeInspection(job, {
        directory,
        connection,
        signal: AbortSignal.timeout(2000),
        onResult: () => assert.fail(),
      }),
      /stopped before/,
    );
    output =
      JSON.stringify({
        type: "result",
        result: {
          index: 5,
          name: "Forged check",
          kind: "page",
          status: "passed",
          severity: "info",
          summary: "",
          expected: "",
          observed: "",
          recommendation: "",
          steps: [],
          durationMs: 0,
          screenshots: [],
          warnings: [],
        },
        evidence: [],
      }) + "\n";
    await assert.rejects(
      executeInspection(job, {
        directory,
        connection,
        signal: AbortSignal.timeout(2000),
        onResult: () => assert.fail(),
      }),
      /does not match/,
    );
    await assert.rejects(
      parseEvents(
        (async function* () {
          yield Buffer.alloc(17 * 1024 * 1024 + 1, 65);
        })(),
        async () => assert.fail(),
      ),
      /budget/,
    );
    assert.throws(
      () =>
        validateWorkerConnection({ url: "http://untrusted.example", token }),
      /HTTPS/,
    );
    assert.throws(
      () =>
        validateWorkerConnection({ url: "https://worker.example/path", token }),
      /exact/,
    );
    assert.throws(
      () =>
        validateWorkerConnection({
          url: "https://worker.example",
          token: "short",
        }),
      /secret/,
    );
  } finally {
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
    if (directory.startsWith(join(tmpdir(), "inspector-protocol-")))
      rmSync(directory, { recursive: true, force: true });
  }
});
