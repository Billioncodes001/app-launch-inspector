import { createServer, type IncomingMessage } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { Store, validId } from "./store.js";
import { Runner, reportMarkdown } from "./runner.js";
import { projectSchema } from "./contracts.js";
import { targetPolicy } from "./network.js";
import { demoProject } from "./demo.js";

async function jsonBody(req: IncomingMessage) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw Error("Use application/json");
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 256000) throw Error("Request is too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export async function startServer(options: {
  dataDir: string;
  port?: number;
  demoOrigin: string;
  uiDir?: string;
  stepTimeoutMs?: number;
}) {
  const store = new Store(options.dataDir),
    token = randomBytes(32).toString("hex");
  const uiDir = resolve(options.uiDir ?? "ui-dist");
  const index = (await readFile(join(uiDir, "index.html"), "utf8")).replace(
    "__INSPECTOR_TOKEN__",
    token,
  );
  let origin = "",
    runner: Runner;
  let pending = 0;
  const server = createServer((req, res) => {
    const send = (status: number, data: unknown, type = "application/json") => {
      res.writeHead(status, { "Content-Type": type });
      res.end(
        type === "application/json"
          ? JSON.stringify(data)
          : (data as string | Buffer),
      );
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (
      req.headers.host !== new URL(origin).host ||
      (req.headers.origin && req.headers.origin !== origin) ||
      (req.headers["sec-fetch-site"] &&
        !["same-origin", "none"].includes(
          String(req.headers["sec-fetch-site"]),
        ))
    ) {
      send(403, { error: "Only this local workspace origin is allowed" });
      return;
    }
    void (async () => {
      const path = new URL(req.url ?? "/", origin).pathname;
      if (path.startsWith("/api/")) {
        const supplied = Buffer.from(
          String(req.headers["x-inspector-token"] ?? ""),
        );
        const expected = Buffer.from(token);
        if (
          supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)
        ) {
          send(403, {
            error: "Reload the workspace to establish a new local session",
          });
          return;
        }
        if (pending >= 24) {
          send(429, { error: "Too many pending local requests" });
          return;
        }
        pending++;
        try {
          if (path === "/api/state" && req.method === "GET") {
            send(200, {
              projects: store.listProjects(),
              runs: store.listRuns(),
              version: "0.1.0",
              demoOrigin: options.demoOrigin,
            });
            return;
          }
          if (path === "/api/projects" && req.method === "POST") {
            const input = projectSchema.parse(await jsonBody(req));
            await targetPolicy(input.baseUrl, [
              (server.address() as AddressInfo).port,
            ]);
            send(201, store.saveProject(input));
            return;
          }
          const project = path.match(/^\/api\/projects\/([^/]+)$/);
          if (project && req.method === "PUT") {
            const input = projectSchema.parse(await jsonBody(req));
            await targetPolicy(input.baseUrl, [
              (server.address() as AddressInfo).port,
            ]);
            send(200, store.saveProject(input, validId(project[1])));
            return;
          }
          if (path === "/api/demo" && req.method === "POST") {
            const { variant } = z
              .object({ variant: z.enum(["broken", "fixed"]) })
              .strict()
              .parse(await jsonBody(req));
            const previous = store
              .listProjects()
              .find(
                (p) => p.demo === variant && p.baseUrl === options.demoOrigin,
              );
            send(
              201,
              previous ??
                store.saveProject(
                  demoProject(options.demoOrigin, variant),
                  undefined,
                  variant,
                ),
            );
            return;
          }
          if (path === "/api/runs" && req.method === "POST") {
            const body = z
              .object({
                projectId: z.string().uuid(),
                authorized: z.literal(true),
              })
              .strict()
              .parse(await jsonBody(req));
            send(202, await runner.enqueue(store.getProject(body.projectId)));
            return;
          }
          const runPath = path.match(
            /^\/api\/runs\/([^/]+)(?:\/(cancel|export|evidence)(?:\/([^/]+))?)?$/,
          );
          if (runPath) {
            const id = validId(runPath[1]),
              action = runPath[2];
            if (action === "cancel" && req.method === "POST") {
              await jsonBody(req);
              await runner.cancel(id);
              send(200, { cancelled: true });
              return;
            }
            if (req.method === "GET") {
              const run = store.getRun(id);
              if (!action) {
                send(200, run);
                return;
              }
              if (action === "export") {
                const markdown =
                  new URL(req.url ?? "/", origin).searchParams.get("format") ===
                  "md";
                res.setHeader(
                  "Content-Disposition",
                  `attachment; filename="inspection-${id}.${markdown ? "md" : "json"}"`,
                );
                send(
                  200,
                  markdown ? reportMarkdown(run) : run,
                  markdown
                    ? "text/markdown; charset=utf-8"
                    : "application/json",
                );
                return;
              }
              if (action === "evidence" && runPath[3]) {
                const filename = runPath[3];
                if (
                  !/^\d+-\d+\.png$/.test(filename) ||
                  !run.results.some((r) =>
                    r.screenshots.some((s) => s.file === filename),
                  )
                )
                  throw Error("Evidence not found");
                send(
                  200,
                  await readFile(join(store.runDir(id), filename)),
                  "image/png",
                );
                return;
              }
            }
          }
          send(404, { error: "Route not found" });
          return;
        } finally {
          pending--;
        }
      }
      if (req.method !== "GET") {
        send(405, { error: "Method not allowed" });
        return;
      }
      if (path === "/") {
        send(200, index, "text/html; charset=utf-8");
        return;
      }
      if (!/^\/(assets\/[A-Za-z0-9_.-]+|mark\.svg)$/.test(path)) {
        send(404, { error: "Asset not found" });
        return;
      }
      const data = await readFile(join(uiDir, path.slice(1)));
      const types: Record<string, string> = {
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
        ".woff": "font/woff",
      };
      send(200, data, types[extname(path)] ?? "application/octet-stream");
    })().catch((error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const isValidation = error instanceof z.ZodError;
      const message = isValidation
        ? error.issues
            .map(
              (e: { path: PropertyKey[]; message: string }) =>
                `${e.path.join(".")}: ${e.message}`,
            )
            .join("; ")
        : error instanceof Error
          ? error.message
          : "Request could not be completed";
      send(400, {
        error: message.startsWith("ENOENT")
          ? "Record or asset not found"
          : message.slice(0, 800),
      });
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  await new Promise<void>((resolve) =>
    server.listen(options.port ?? 8795, "127.0.0.1", resolve),
  );
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
  runner = new Runner(store, port, { stepTimeoutMs: options.stepTimeoutMs });
  return {
    origin,
    store,
    runner,
    close: async () => {
      await runner.close();
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
