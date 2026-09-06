import {
  createServer,
  type ServerResponse,
  type IncomingMessage,
} from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { ProjectInput } from "./contracts.js";

export const DEMO_PASSWORD = "inspector-demo-only-2026";
const users: { [key: string]: { id: string; name: string; role: string } } = {
  "owner@example.test": { id: "owner", name: "Alex Member", role: "member" },
  "other@example.test": { id: "other", name: "Jordan Member", role: "member" },
  "admin@example.test": {
    id: "admin",
    name: "Sam Administrator",
    role: "admin",
  },
};
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export async function startDemo(port = 8796) {
  const verificationRecords = new Set<string>();
  const sessions = new Map<
    string,
    { id: string; name: string; role: string; variant: string }
  >();
  let origin = "";
  const html = (
    res: ServerResponse,
    status: number,
    title: string,
    body: string,
  ) => {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
    });
    res.end(
      `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><title>${title} · Sample workspace</title><style>body{margin:0;background:#f4f6fc;color:#202b45;font:16px system-ui}header{background:white;padding:24px 8%;border-bottom:1px solid #d9dfed;display:flex;justify-content:space-between}main{max-width:720px;margin:60px auto;padding:36px;background:white;border:1px solid #d9dfed;border-radius:12px}a{color:#4139bd;margin-right:16px}label{display:block;margin:20px 0 7px}input{display:block;padding:12px;width:90%;border:1px solid #77829c;border-radius:5px;font:inherit}button{background:#4f46e5;color:white;border:0;border-radius:5px;padding:12px 22px;margin-top:24px;font:inherit}p{line-height:1.8}.notice{color:#67536a;font-size:13px}h1{font-weight:600}strong{display:block;padding:20px;background:#eef1ff}</style></head><body><header><b>Sample workspace</b><span class="notice">Controlled test application · Synthetic accounts</span></header><main><h1>${escape(title)}</h1>${body}</main></body></html>`,
    );
  };
  const server = createServer(
    (req, res) =>
      void (async () => {
        if (req.headers.host !== new URL(origin).host) {
          res.writeHead(403);
          res.end();
          return;
        }
        if (
          req.method === "GET" &&
          req.url === "/.well-known/launch-inspector.txt"
        ) {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end([...verificationRecords].join("\n"));
          return;
        }
        if (
          req.method === "POST" &&
          req.headers.origin &&
          req.headers.origin !== origin
        ) {
          res.writeHead(403);
          res.end();
          return;
        }
        const url = new URL(req.url ?? "/", origin);
        const match = url.pathname.match(/^\/(broken|fixed)(\/.*)?$/);
        if (!match) {
          html(res, 404, "Not found", "");
          return;
        }
        const variant = match[1],
          path = match[2] ?? "/",
          prefix = "/" + variant;
        const cookie = req.headers.cookie
          ?.split(";")
          .map((s) => s.trim())
          .find((s) => s.startsWith("demo_" + variant + "="))
          ?.split("=")[1];
        const session = cookie ? sessions.get(cookie) : undefined;
        const redirect = (path: string) => {
          res.writeHead(303, { Location: prefix + path });
          res.end();
        };
        if (path === "/login") {
          let invalid = false;
          if (req.method === "POST") {
            const values = new URLSearchParams(await body(req));
            const user = users[values.get("email") ?? ""];
            if (user && values.get("password") === DEMO_PASSWORD) {
              if (sessions.size >= 2000) sessions.clear();
              const key = randomUUID();
              sessions.set(key, { ...user, variant });
              res.setHeader(
                "Set-Cookie",
                `demo_${variant}=${key}; Path=/${variant}; HttpOnly; SameSite=Strict`,
              );
              redirect("/account");
              return;
            }
            invalid = true;
          }
          html(
            res,
            200,
            "Sign in",
            `${invalid ? '<p role="alert">Email or password is incorrect</p>' : ""}<form method="post"><label for="email">Email</label><input id="email" name="email" type="email" required autocomplete="username"><label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="current-password"><button>Sign in</button></form>`,
          );
          return;
        }
        if (path === "/") {
          html(
            res,
            200,
            "A workspace for your team",
            `<p>This ${variant === "broken" ? "intentionally faulty" : "corrected"} application is used to verify the inspector. It contains synthetic data only.</p><a href="${prefix}/login">Sign in</a>`,
          );
          return;
        }
        if (path === "/admin" && variant === "broken") {
          html(
            res,
            200,
            "Billing administration",
            "<p>This protected section is exposed by a deliberately missing authorization check.</p><strong>Billing administration</strong>",
          );
          return;
        }
        if (!session || session.variant !== variant) {
          redirect("/login");
          return;
        }
        const nav = `<nav><a href="${prefix}/account">Workspace</a><a href="${prefix}/settings">Settings</a><a href="${prefix}/admin">Administration</a></nav>`;
        if (path === "/account") {
          html(
            res,
            200,
            "Your workspace",
            `${nav}<p>Signed in as ${escape(session.name)}</p><a href="${prefix}/documents/owner-report">Open quarterly report</a>`,
          );
          return;
        }
        if (path === "/admin") {
          if (session.role !== "admin") {
            html(
              res,
              403,
              "Access denied",
              "<p>Your account cannot access this section.</p>",
            );
            return;
          }
          html(
            res,
            200,
            "Billing administration",
            nav + "<p>Administrator access confirmed.</p>",
          );
          return;
        }
        if (path === "/documents/owner-report") {
          if (variant === "fixed" && session.id !== "owner") {
            html(
              res,
              403,
              "Access denied",
              "<p>This document belongs to another account.</p>",
            );
            return;
          }
          html(
            res,
            200,
            "Owner's quarterly report",
            nav +
              "<p>Synthetic owner-only content. The corrected application checks resource ownership on the server.</p>",
          );
          return;
        }
        if (path === "/settings") {
          if (req.method === "POST") {
            const values = new URLSearchParams(await body(req));
            if (variant === "fixed")
              session.name = (values.get("name") ?? session.name).slice(0, 100);
            redirect("/settings");
            return;
          }
          html(
            res,
            200,
            "Profile settings",
            `${nav}<p>Current display name: <b>${escape(session.name)}</b></p><form method="post"><label for="name">Display name</label><input id="name" name="name" value="${escape(session.name)}"><button>Save changes</button></form>`,
          );
          return;
        }
        html(res, 404, "Not found", "");
      })().catch(() => {
        if (!res.headersSent) res.writeHead(400);
        res.end("Request rejected");
      }),
  );
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    publishVerification(value: string) {
      verificationRecords.add(value);
    },
    origin,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeAllConnections();
      }),
  };
}
async function body(req: IncomingMessage) {
  let result = "";
  for await (const chunk of req) {
    result += chunk;
    if (result.length > 16000) throw Error("Too large");
  }
  return result;
}
export function demoProject(
  origin: string,
  variant: "broken" | "fixed",
): ProjectInput {
  const p = "/" + variant;
  return {
    name:
      variant === "broken"
        ? "Sample app · Before fixes"
        : "Sample app · After fixes",
    baseUrl: origin,
    repository: "",
    login: {
      path: p + "/login",
      usernameLabel: "Email",
      passwordLabel: "Password",
      button: "Sign in",
      successPath: p + "/account",
      successText: "Your workspace",
      errorText: "Email or password is incorrect",
    },
    accounts: Object.entries(users).map(([username, u]) => ({
      id: u.id,
      name: u.name,
      username,
      password: DEMO_PASSWORD,
    })),
    checks: [
      {
        kind: "page",
        name: "Public landing page",
        path: p + "/",
        expectedText: "A workspace for your team",
      },
      {
        kind: "login",
        name: "Sign-in and invalid-password rejection",
        account: "owner",
        rejectInvalid: true,
      },
      {
        kind: "access",
        name: "Signed-out access to administration",
        path: p + "/admin",
        owner: "admin",
        actor: "anonymous",
        expectedText: "Billing administration",
        deniedText: "Access denied",
      },
      {
        kind: "access",
        name: "Member access to administration",
        path: p + "/admin",
        owner: "admin",
        actor: "owner",
        expectedText: "Billing administration",
        deniedText: "Access denied",
      },
      {
        kind: "access",
        name: "Another member’s private document",
        path: p + "/documents/owner-report",
        owner: "owner",
        actor: "other",
        expectedText: "Owner's quarterly report",
        deniedText: "Access denied",
      },
      {
        kind: "journey",
        name: "Save a profile change and reload",
        account: "owner",
        steps: [
          { action: "visit", path: p + "/settings" },
          { action: "fill", label: "Display name", value: "Ready for launch" },
          { action: "click", role: "button", label: "Save changes" },
          { action: "visit", path: p + "/settings" },
          { action: "expect", text: "Ready for launch" },
        ],
      },
    ],
  };
}
