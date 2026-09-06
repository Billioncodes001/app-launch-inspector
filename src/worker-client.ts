import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import {
  browserEnvironment,
  workerEventSchema,
  workerJobSchema,
  type WorkerEvent,
  type WorkerJob,
} from "./worker-protocol.js";
import type { CheckResult } from "./contracts.js";
export type WorkerConnection = { url: string; token: string };
export function validateWorkerConnection(connection: WorkerConnection) {
  const u = new URL(connection.url);
  if (
    u.origin !== connection.url ||
    u.username ||
    u.password ||
    (u.protocol !== "https:" &&
      !(
        u.protocol === "http:" &&
        ["worker", "127.0.0.1", "localhost"].includes(u.hostname)
      ))
  )
    throw Error(
      "Use an exact HTTPS worker origin, or the private worker/loopback HTTP service",
    );
  if (connection.token.length < 32)
    throw Error(
      "Worker authentication needs a secret of at least 32 characters",
    );
}
export async function parseEvents(
  stream: AsyncIterable<Uint8Array>,
  onEvent: (event: WorkerEvent) => Promise<void>,
) {
  let pending = Buffer.alloc(0),
    total = 0;
  for await (const bytes of stream) {
    total += bytes.length;
    if (total > 100 * 1024 * 1024)
      throw Error("Worker evidence exceeds the run budget");
    pending = Buffer.concat([pending, bytes]);
    let newline: number;
    while ((newline = pending.indexOf(10)) !== -1) {
      const line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (line.length > 17 * 1024 * 1024)
        throw Error("Worker message exceeds the result budget");
      await onEvent(workerEventSchema.parse(JSON.parse(line.toString("utf8"))));
    }
    if (pending.length > 17 * 1024 * 1024)
      throw Error("Worker message exceeds the result budget");
  }
  if (pending.length) throw Error("Worker response was incomplete");
}
export async function executeProcess(
  job: WorkerJob,
  signal: AbortSignal,
  onEvent: (event: WorkerEvent) => Promise<void>,
) {
  if (signal.aborted) throw Error("Inspection cancelled");
  const compiled = fileURLToPath(new URL("./worker-child.js", import.meta.url));
  const program = existsSync(compiled)
    ? compiled
    : fileURLToPath(new URL("../dist/worker-child.js", import.meta.url));
  if (!existsSync(program))
    throw Error("Build the inspection worker before starting the service");
  const directory = mkdtempSync(join(tmpdir(), "inspector-job-"));
  const child = spawn(process.execPath, ["--max-old-space-size=256", program], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...browserEnvironment(),
      PLAYWRIGHT_BROWSERS_PATH:
        process.env.PLAYWRIGHT_BROWSERS_PATH ??
        dirname(dirname(dirname(chromium.executablePath()))),
      HOME: directory,
      TMPDIR: directory,
      TEMP: directory,
      TMP: directory,
      INSPECTOR_JOB_DIR: directory,
    },
    cwd: directory,
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  let stderr = "",
    killTimer: ReturnType<typeof setTimeout> | undefined;
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-2000);
  });
  child.stdin.on("error", () => undefined);
  const done = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  void done.catch(() => undefined);
  const kill = () => {
    if (!child.pid || child.exitCode !== null || child.signalCode) return;
    if (process.platform === "win32")
      execFile(
        "taskkill",
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true },
        () => undefined,
      );
    else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }
  };
  const cancel = () => {
    if (process.platform === "win32") kill();
    else {
      child.kill("SIGTERM");
      killTimer = setTimeout(kill, 2000);
    }
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
  child.stdin.end(JSON.stringify(job));
  try {
    await parseEvents(child.stdout, onEvent);
    const code = await done;
    if (signal.aborted) throw Error("Inspection cancelled");
    if (code !== 0)
      throw Error(
        "Inspection worker exited unexpectedly" +
          (stderr ? ". Check the worker runtime." : "."),
      );
  } finally {
    signal.removeEventListener("abort", cancel);
    if (killTimer) clearTimeout(killTimer);
    kill();
    await done.catch(() => undefined);
    if (directory.startsWith(join(tmpdir(), "inspector-job-")))
      rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
  }
}
export async function executeInspection(
  job: WorkerJob,
  options: {
    signal: AbortSignal;
    directory: string;
    connection?: WorkerConnection;
    onResult: (result: CheckResult) => void;
  },
) {
  workerJobSchema.parse(job);
  let completed = false,
    index = 0;
  const onEvent = async (event: WorkerEvent) => {
    if (completed) throw Error("Worker sent data after completion");
    if (event.type === "error") throw Error(event.message);
    if (event.type === "done") {
      if (index !== job.project.checks.length)
        throw Error("Worker omitted inspection results");
      completed = true;
      return;
    }
    const result = event.result;
    if (
      result.index !== index ||
      result.kind !== job.project.checks[index]?.kind ||
      result.name !== job.project.checks[index]?.name
    )
      throw Error("Worker result does not match the inspection plan");
    if (
      event.evidence.length !== result.screenshots.length ||
      new Set(event.evidence.map((e) => e.file)).size !== event.evidence.length
    )
      throw Error("Worker evidence is incomplete");
    for (const evidence of event.evidence) {
      if (
        !evidence.file.startsWith(index + "-") ||
        !result.screenshots.some((s) => s.file === evidence.file)
      )
        throw Error("Worker evidence is outside this result");
      const bytes = Buffer.from(evidence.data, "base64");
      if (
        bytes.length < 8 ||
        !bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        throw Error("Worker returned invalid PNG evidence");
      writeFileSync(join(options.directory, evidence.file), bytes, {
        flag: "wx",
        mode: 0o600,
      });
    }
    options.onResult(result);
    index++;
  };
  if (options.connection) {
    validateWorkerConnection(options.connection);
    const response = await fetch(options.connection.url + "/jobs", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + options.connection.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(job),
      signal: options.signal,
      redirect: "error",
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw Error(
        response.status === 429
          ? "Inspection workers are at capacity. Try again shortly."
          : "The inspection worker is unavailable or rejected the request",
      );
    }
    try {
      await parseEvents(response.body, onEvent);
    } finally {
      await response.body.cancel().catch(() => undefined);
    }
  } else await executeProcess(job, options.signal, onEvent);
  if (!completed)
    throw Error(
      "Worker stopped before confirming completion. This inspection will not be replayed.",
    );
}
