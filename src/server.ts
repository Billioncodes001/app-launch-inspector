import { createServer, type IncomingMessage } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { z } from "zod";
import { Store, validId } from "./store.js";
import { Runner, reportMarkdown } from "./runner.js";
import {
  projectSchema,
  memberSchema,
  reviewSchema,
  type Membership,
  type PublicProject,
} from "./contracts.js";
import { targetPolicy } from "./network.js";
import { demoProject } from "./demo.js";
import { Access } from "./access.js";
import { Authentication, equal, type OidcSettings } from "./auth.js";
import { localActor } from "./database.js";
import { BrowserCapacity } from "./capacity.js";
import { HttpError } from "./errors.js";
import { acquireLease } from "./operations.js";

async function jsonBody(req: IncomingMessage) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new HttpError(415, "Use application/json");
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 256000) throw new HttpError(413, "Request is too large");
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must contain valid JSON");
  }
}
function viewerProject(project: PublicProject): PublicProject {
  return {
    ...project,
    accounts: project.accounts.map((a) => ({ ...a, username: "" })),
    checks: project.checks.map((c) =>
      c.kind === "journey"
        ? {
            ...c,
            steps: c.steps.map((s) =>
              s.action === "fill" ? { ...s, value: "" } : s,
            ),
          }
        : c,
    ),
  };
}
export async function startServer(options: {
  dataDir: string;
  port?: number;
  demoOrigin?: string;
  uiDir?: string;
  stepTimeoutMs?: number;
  mode?: "local" | "hosted";
  host?: string;
  publicOrigin?: string;
  oidc?: OidcSettings;
  allowLoopbackTargetsForTests?: boolean;
  browserSandbox?: boolean;
}) {
  const hosted = options.mode === "hosted",
    host = options.host ?? "127.0.0.1";
  if (!hosted && host !== "127.0.0.1")
    throw Error("Local mode must bind to 127.0.0.1");
  if (hosted && (!options.oidc || !options.publicOrigin))
    throw Error("Hosted mode requires a public origin and OIDC settings");
  if (options.publicOrigin) {
    const url = new URL(options.publicOrigin);
    if (
      url.origin !== options.publicOrigin ||
      url.username ||
      url.password ||
      (url.protocol !== "https:" &&
        !(options.oidc?.allowHttpForTests && url.hostname === "127.0.0.1"))
    )
      throw Error("The hosted public origin must be an exact HTTPS origin");
  }
  const store = new Store(options.dataDir),
    access = new Access(store.database),
    capacity = new BrowserCapacity(2, 20);
  let stopOnLeaseLost = () => {};
  let lease: ReturnType<typeof acquireLease>;
  try {
    lease = acquireLease(store.database, () => stopOnLeaseLost());
  } catch (error) {
    store.close();
    throw error;
  }
  const token = randomBytes(32).toString("hex"),
    uiDir = resolve(options.uiDir ?? "ui-dist");
  let index: string;
  const auth = hosted
    ? new Authentication(access, options.publicOrigin!, options.oidc!)
    : undefined;
  try {
    index = (await readFile(join(uiDir, "index.html"), "utf8")).replace(
      "__INSPECTOR_TOKEN__",
      token,
    );
    await auth?.initialize();
    if (!lease.active)
      throw Error("The data directory lease was lost during startup");
  } catch (error) {
    lease.release();
    store.close();
    throw error;
  }
  let origin = options.publicOrigin ?? "",
    pending = 0,
    stopping = false;
  const runners = new Map<string, Runner>();
  const allowLoopback =
    !hosted || options.allowLoopbackTargetsForTests === true;
  const rootOrg: Membership = {
    organizationId: "local",
    name: "Local workspace",
    email: "",
    role: "owner",
    projectIds: [],
    version: 1,
  };
  // Recovery happens once at service startup, before a runner can enqueue anything.
  try {
    store.recover();
    for (const o of access.organizations()) store.scope(o.id).recover();
  } catch (error) {
    lease.release();
    store.close();
    throw error;
  }
  const checkTarget = (org: string, baseUrl: string) => {
    if (
      hosted &&
      (!access.organization(org).origins.includes(baseUrl) ||
        baseUrl === origin)
    )
      throw new HttpError(
        403,
        "This target is not approved for your organization. Ask the service operator to approve it.",
      );
  };
  const runnerFor = (org: string) => {
    let runner = runners.get(org);
    if (!runner) {
      runner = new Runner(
        org === "local" ? store : store.scope(org),
        (server.address() as AddressInfo).port,
        {
          stepTimeoutMs: options.stepTimeoutMs,
          capacity,
          allowLoopback,
          sandbox: options.browserSandbox ?? hosted,
          authorize: (p, actor) => {
            checkTarget(org, p.baseUrl);
            if (hosted) {
              const m = access.member(actor, org);
              access.assertWrite(m);
              access.assertProject(m, p.id);
            }
          },
        },
      );
      runners.set(org, runner);
    }
    return runner;
  };
  const rate = new Map<string, { count: number; until: number }>();
  const server = createServer((req, res) => {
    const requestId = randomUUID();
    const send = (status: number, data: unknown, type = "application/json") => {
      res.writeHead(status, { "Content-Type": type });
      res.end(
        type === "application/json"
          ? JSON.stringify(data)
          : (data as string | Buffer),
      );
    };
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Request-ID", requestId);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=()",
    );
    if (origin.startsWith("https:"))
      res.setHeader("Strict-Transport-Security", "max-age=31536000");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; font-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    void (async () => {
      const url = new URL(req.url ?? "/", origin),
        path = url.pathname;
      const navigation =
        req.method === "GET" &&
        ["/", "/auth/login", "/auth/callback"].includes(path);
      if (
        req.headers.host !== new URL(origin).host ||
        (req.headers.origin && req.headers.origin !== origin) ||
        (!navigation &&
          req.headers["sec-fetch-site"] &&
          !["same-origin", "none"].includes(
            String(req.headers["sec-fetch-site"]),
          ))
      )
        throw new HttpError(
          403,
          "This request is not from the configured workspace origin",
        );
      if (path === "/healthz" && req.method === "GET") {
        const ready =
          !stopping &&
          lease.active &&
          existsSync(chromium.executablePath()) &&
          [...runners.values()].every((r) => r.healthy);
        store.database.sql.prepare("SELECT 1").get();
        send(ready ? 200 : 503, {
          status: ready ? "ready" : "unavailable",
          version: "0.2.0",
        });
        return;
      }
      if (auth && path === "/auth/login" && req.method === "GET") {
        await auth.begin(req, res);
        return;
      }
      if (auth && path === "/auth/callback" && req.method === "GET") {
        if (pending >= 12)
          throw new HttpError(429, "Sign-in capacity is temporarily full");
        pending++;
        try {
          await auth.callback(req, res);
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(
            403,
            "The identity provider response could not be verified. Start sign-in again.",
          );
        } finally {
          pending--;
        }
        return;
      }
      if (path.startsWith("/api/")) {
        if (stopping || !lease.active)
          throw new HttpError(503, "Service is stopping");
        if (pending >= 24)
          throw new HttpError(429, "Too many pending requests");
        pending++;
        try {
          const session = auth?.session(
            req,
            path !== "/api/state" && path !== "/api/session",
          );
          if (path === "/api/session" && req.method === "GET") {
            send(200, {
              mode: hosted ? "hosted" : "local",
              authenticated: !hosted || !!session,
              user: hosted ? session?.actor : localActor,
              organizations: hosted
                ? session
                  ? access.memberships(session.actor)
                  : []
                : [rootOrg],
              csrf: hosted ? (session?.csrf ?? "") : token,
            });
            return;
          }
          if (hosted && !session)
            throw new HttpError(
              401,
              "Sign in to access your organization workspace",
            );
          const actor = session?.actor ?? localActor;
          if (
            !equal(
              String(req.headers["x-inspector-token"] ?? ""),
              session?.csrf ?? token,
            )
          )
            throw new HttpError(
              403,
              "Reload the workspace to establish a new session",
            );
          const now = Date.now();
          for (const [id, value] of rate)
            if (value.until < now) rate.delete(id);
          const bucket = rate.get(actor.id) ?? { count: 0, until: now + 60000 };
          if (++bucket.count > 300)
            throw new HttpError(
              429,
              "Request rate limit reached. Try again shortly.",
            );
          rate.set(actor.id, bucket);
          if (path === "/api/logout" && req.method === "POST" && auth) {
            await jsonBody(req);
            auth.logout(req, res, actor);
            send(200, { signedOut: true });
            return;
          }
          const member = hosted
            ? access.member(
                actor,
                String(req.headers["x-inspector-organization"] ?? ""),
              )
            : rootOrg;
          const org = member.organizationId,
            scoped = org === "local" ? store : store.scope(org);
          if (path === "/api/state" && req.method === "GET") {
            const projects = scoped
              .listProjects()
              .filter((p) => access.canProject(member, p.id));
            send(200, {
              projects:
                member.role === "viewer"
                  ? projects.map(viewerProject)
                  : projects,
              runs: scoped
                .listRuns()
                .filter((r) => access.canProject(member, r.projectId)),
              version: "0.2.0",
              demoOrigin: hosted ? "" : options.demoOrigin,
              organization: member,
              approvedOrigins: hosted ? access.organization(org).origins : [],
              permissions: {
                canWrite: member.role !== "viewer",
                canCreate:
                  member.role !== "viewer" && !member.projectIds.length,
                canManage: member.role === "owner",
                canAcceptRisk: member.role === "owner",
              },
            });
            return;
          }
          if (path === "/api/members") {
            access.assertOwner(member);
            if (!hosted)
              throw new HttpError(
                400,
                "Member management is available in hosted mode",
              );
            if (req.method === "GET") {
              send(200, access.members(org));
              return;
            }
            if (req.method === "PUT") {
              send(200, access.saveMember(org, await jsonBody(req), actor));
              return;
            }
            if (req.method === "DELETE") {
              const input = z
                .object({
                  email: z.string().email(),
                  version: z.number().int().min(1),
                })
                .strict()
                .parse(await jsonBody(req));
              access.removeMember(org, input.email, input.version, actor);
              send(200, { removed: true });
              return;
            }
          }
          if (path === "/api/audit" && req.method === "GET") {
            access.assertOwner(member);
            const before = z.coerce
              .number()
              .int()
              .positive()
              .safe()
              .parse(url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER);
            const entries = store.database.auditEntries(org, before);
            send(200, {
              entries,
              next: entries.length === 100 ? entries.at(-1)!.sequence : null,
              integrity: store.database.verifyAudit(org),
            });
            return;
          }
          if (path === "/api/projects" && req.method === "POST") {
            access.assertWrite(member);
            if (member.projectIds.length)
              throw new HttpError(
                403,
                "Project creation requires access to all organization projects",
              );
            const input = projectSchema.parse(await jsonBody(req));
            checkTarget(org, input.baseUrl);
            await targetPolicy(
              input.baseUrl,
              [(server.address() as AddressInfo).port],
              allowLoopback,
            );
            const currentMember = hosted ? access.member(actor, org) : member;
            access.assertWrite(currentMember);
            if (currentMember.projectIds.length)
              throw new HttpError(
                403,
                "Project creation requires access to all organization projects",
              );
            send(201, scoped.saveProject(input, undefined, undefined, actor));
            return;
          }
          const project = path.match(/^\/api\/projects\/([^/]+)$/);
          if (project && req.method === "PUT") {
            access.assertWrite(member);
            access.assertProject(member, project[1]);
            const revision = req.headers["if-match"];
            if (typeof revision !== "string")
              throw new HttpError(
                428,
                "Reload the configuration before updating it",
              );
            const input = projectSchema.parse(await jsonBody(req));
            checkTarget(org, input.baseUrl);
            await targetPolicy(
              input.baseUrl,
              [(server.address() as AddressInfo).port],
              allowLoopback,
            );
            // Authorization is evaluated again after DNS resolution.
            if (hosted) {
              const latest = access.member(actor, org);
              access.assertWrite(latest);
              access.assertProject(latest, project[1]);
            }
            send(
              200,
              scoped.saveProject(
                input,
                validId(project[1]),
                undefined,
                actor,
                revision.replace(/^"|"$/g, ""),
              ),
            );
            return;
          }
          if (path === "/api/demo" && req.method === "POST") {
            if (hosted || !options.demoOrigin)
              throw new HttpError(
                404,
                "Controlled samples are available in local mode",
              );
            const { variant } = z
              .object({ variant: z.enum(["broken", "fixed"]) })
              .strict()
              .parse(await jsonBody(req));
            const previous = scoped
              .listProjects()
              .find(
                (p) => p.demo === variant && p.baseUrl === options.demoOrigin,
              );
            send(
              201,
              previous ??
                scoped.saveProject(
                  demoProject(options.demoOrigin, variant),
                  undefined,
                  variant,
                  actor,
                ),
            );
            return;
          }
          if (path === "/api/runs" && req.method === "POST") {
            access.assertWrite(member);
            const body = z
              .object({
                projectId: z.string().uuid(),
                revision: z.string().uuid(),
                authorized: z.literal(true),
              })
              .strict()
              .parse(await jsonBody(req));
            access.assertProject(member, body.projectId);
            const p = scoped.getProject(body.projectId);
            if (p.revision !== body.revision)
              throw new HttpError(
                409,
                "This configuration changed. Review the latest version and authorize it again.",
              );
            send(202, await runnerFor(org).enqueue(p, actor));
            return;
          }
          const reviewPath = path.match(
            /^\/api\/runs\/([^/]+)\/reviews\/(\d+)$/,
          );
          if (reviewPath && req.method === "PUT") {
            access.assertWrite(member);
            const run = scoped.getRun(reviewPath[1]);
            access.assertProject(member, run.projectId);
            const input = reviewSchema.parse(await jsonBody(req));
            if (input.status === "accepted_risk") access.assertOwner(member);
            send(
              200,
              scoped.review(run.id, Number(reviewPath[2]), input, actor),
            );
            return;
          }
          const runPath = path.match(
            /^\/api\/runs\/([^/]+)(?:\/(cancel|export|evidence)(?:\/([^/]+))?)?$/,
          );
          if (runPath) {
            const id = validId(runPath[1]),
              action = runPath[2],
              run = scoped.getRun(id);
            access.assertProject(member, run.projectId);
            if (action === "cancel" && req.method === "POST") {
              access.assertWrite(member);
              z.object({})
                .strict()
                .parse(await jsonBody(req));
              await runnerFor(org).cancel(id);
              store.database.audit(org, actor, "run.cancel_requested", id);
              send(200, { cancelled: true });
              return;
            }
            if (req.method === "GET") {
              if (!action) {
                send(200, run);
                return;
              }
              if (action === "export") {
                const format = z
                  .enum(["md", "json"])
                  .parse(url.searchParams.get("format") ?? "json");
                store.database.audit(org, actor, "report.exported", id, {
                  format,
                });
                res.setHeader(
                  "Content-Disposition",
                  `attachment; filename="inspection-${id}.${format}"`,
                );
                send(
                  200,
                  format === "md" ? reportMarkdown(run) : run,
                  format === "md"
                    ? "text/markdown; charset=utf-8"
                    : "application/json",
                );
                return;
              }
              if (action === "evidence" && runPath[3]) {
                const file = runPath[3];
                if (
                  !/^\d+-\d+\.png$/.test(file) ||
                  !run.results.some((r) =>
                    r.screenshots.some((s) => s.file === file),
                  )
                )
                  throw new HttpError(404, "Evidence not found");
                send(
                  200,
                  await readFile(join(scoped.runDir(id), file)),
                  "image/png",
                );
                return;
              }
            }
          }
          throw new HttpError(404, "Route not found");
        } finally {
          pending--;
        }
      }
      if (req.method !== "GET") throw new HttpError(405, "Method not allowed");
      if (path === "/") {
        send(200, index, "text/html; charset=utf-8");
        return;
      }
      if (!/^\/(assets\/[A-Za-z0-9_.-]+|mark\.svg)$/.test(path))
        throw new HttpError(404, "Asset not found");
      const types: Record<string, string> = {
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".woff2": "font/woff2",
        ".woff": "font/woff",
      };
      send(
        200,
        await readFile(join(uiDir, path.slice(1))),
        types[extname(path)] ?? "application/octet-stream",
      );
    })().catch((error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status =
        error instanceof HttpError
          ? error.status
          : error instanceof z.ZodError || error instanceof TypeError
            ? 400
            : 500;
      const message =
        error instanceof HttpError
          ? error.message
          : error instanceof z.ZodError
            ? error.issues
                .map((e) => `${e.path.join(".")}: ${e.message}`)
                .join("; ")
            : "The request could not be completed. Review the server configuration or contact the operator.";
      if (status >= 500)
        console.error(
          JSON.stringify({ event: "request.failed", requestId, status }),
        );
      send(status, { error: message.slice(0, 800), requestId });
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.maxHeadersCount = 50;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 8795, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    lease.release();
    store.close();
    throw error;
  }
  const port = (server.address() as AddressInfo).port;
  origin ||= `http://127.0.0.1:${port}`;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      stopping = true;
      try {
        await Promise.all([...runners.values()].map((r) => r.close()));
        await new Promise<void>((resolve, reject) => {
          server.close((e) => (e ? reject(e) : resolve()));
          server.closeAllConnections();
        });
      } finally {
        lease.release();
        store.close();
      }
    })());
  stopOnLeaseLost = () => {
    void close();
  };
  return {
    origin,
    store,
    access,
    capacity,
    get runner() {
      return runnerFor("local");
    },
    close,
  };
}
