import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { executeProcess } from "./worker-client.js";
import { workerJobSchema, type WorkerEvent } from "./worker-protocol.js";
import { targetPolicy } from "./network.js";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
export async function startWorker(options: {
  token: string;
  host?: string;
  port?: number;
  allowLoopbackForTests?: boolean;
  sandboxForTests?: boolean;
}) {
  if (options.token.length < 32)
    throw Error("Configure a worker secret with at least 32 characters");
  const jobs = new Set<AbortController>(),
    tasks = new Set<Promise<void>>();
  let closing = false,
    pending = 0;
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const provided = Buffer.from(String(req.headers.authorization ?? "")),
      expected = Buffer.from("Bearer " + options.token);
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    ) {
      res.writeHead(401);
      res.end();
      return;
    }
    if (req.url === "/healthz" && req.method === "GET") {
      const ready = !closing && existsSync(chromium.executablePath());
      res.writeHead(ready ? 200 : 503, {
        "Content-Type": "application/json",
      });
      res.end(
        JSON.stringify({
          status: ready ? "ready" : "unavailable",
          active: jobs.size,
          capacity: 2,
        }),
      );
      return;
    }
    if (closing || jobs.size + pending >= 2) {
      res.writeHead(429);
      res.end();
      return;
    }
    if (req.url !== "/jobs" || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }
    if (!req.headers["content-type"]?.startsWith("application/json")) {
      res.writeHead(415);
      res.end();
      return;
    }
    pending++;
    const task = (async () => {
      let abort: AbortController | undefined,
        timeout: ReturnType<typeof setTimeout> | undefined,
        reserved = true;
      const send = async (event: WorkerEvent) => {
        if (res.destroyed) throw Error("Worker client disconnected");
        await new Promise<void>((resolve, reject) =>
          res.write(JSON.stringify(event) + "\n", (error) =>
            error ? reject(error) : resolve(),
          ),
        );
      };
      try {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 256000) throw Error("Worker request too large");
          chunks.push(chunk);
        }
        const job = workerJobSchema.parse(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
        );
        job.allowLoopback = options.allowLoopbackForTests === true;
        job.sandbox = options.sandboxForTests ?? true;
        job.forbiddenPorts.push((server.address() as AddressInfo).port);
        await targetPolicy(
          job.project.baseUrl,
          job.forbiddenPorts,
          job.allowLoopback,
        );
        abort = new AbortController();
        jobs.add(abort);
        pending--;
        reserved = false;
        res.on("close", () => abort?.abort());
        timeout = setTimeout(() => abort?.abort(), 180000);
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.flushHeaders();
        await executeProcess(job, abort.signal, send);
        res.end();
      } catch {
        if (!res.headersSent) {
          res.writeHead(400);
          res.end();
        } else {
          await send({
            type: "error",
            message:
              "Inspection worker stopped unexpectedly. Remaining checks were not run.",
          }).catch(() => undefined);
          res.end();
        }
      } finally {
        if (timeout) clearTimeout(timeout);
        if (abort) jobs.delete(abort);
        if (reserved) pending--;
      }
    })();
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  });
  server.requestTimeout = 20000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 20;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8799, options.host ?? "127.0.0.1", resolve);
  });
  return {
    origin: "http://127.0.0.1:" + (server.address() as AddressInfo).port,
    async close() {
      closing = true;
      for (const job of jobs) job.abort();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await Promise.allSettled([...tasks]);
    },
  };
}
