// A real signed OIDC protocol fixture. It never authenticates production users.
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { generateKeyPair, exportJWK, SignJWT } from "jose";

export const identities = {
  "owner-a@example.test": "Avery · Northstar",
  "owner-b@example.test": "Blake · Harbor",
  "viewer-a@example.test": "Casey · Read only",
  "editor-a@example.test": "Drew · Editor",
  "unapproved@example.test": "Unapproved account",
  "unverified@example.test": "Unverified account",
  "new-owner@example.test": "Morgan · New organization",
  "new-reviewer@example.test": "Riley · Invited reviewer",
};
export async function oidcFixture() {
  const key = await generateKeyPair("RS256", { extractable: true }),
    wrong = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(key.publicKey)),
    kid: "fixture-key",
    alg: "RS256",
    use: "sig",
  };
  const codes = new Map<
    string,
    {
      email: keyof typeof identities;
      nonce: string;
      challenge: string;
      redirect: string;
    }
  >();
  let origin = "",
    nextFault = "";
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", origin);
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (url.pathname === "/.well-known/openid-configuration")
        return json({
          issuer: origin,
          authorization_endpoint: origin + "/authorize",
          token_endpoint: origin + "/token",
          jwks_uri: origin + "/jwks",
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: [
            "client_secret_post",
            "client_secret_basic",
          ],
          code_challenge_methods_supported: ["S256"],
        });
      if (url.pathname === "/jwks") return json({ keys: [jwk] });
      if (url.pathname === "/authorize") {
        const email = url.searchParams.get("email") as keyof typeof identities;
        if (
          email &&
          identities[email] &&
          url.searchParams.get("approve") === "1"
        ) {
          const redirect = url.searchParams.get("redirect_uri") ?? "",
            destination = new URL(redirect);
          if (
            destination.hostname !== "127.0.0.1" ||
            destination.pathname !== "/auth/callback" ||
            url.searchParams.get("code_challenge_method") !== "S256"
          )
            return json({ error: "invalid_request" }, 400);
          const code = randomUUID();
          codes.set(code, {
            email,
            nonce: url.searchParams.get("nonce") ?? "",
            challenge: url.searchParams.get("code_challenge") ?? "",
            redirect,
          });
          destination.searchParams.set("code", code);
          destination.searchParams.set(
            "state",
            url.searchParams.get("state") ?? "",
          );
          destination.searchParams.set("iss", origin);
          res.writeHead(303, { Location: destination.href });
          res.end();
          return;
        }
        const escape = (s: string) =>
          s
            .replaceAll("&", "&amp;")
            .replaceAll('"', "&quot;")
            .replaceAll("<", "&lt;");
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          `<html lang="en"><head><title>Test identity provider</title></head><body><h1>Controlled sign-in provider</h1><p>Synthetic identities for protocol testing only.</p><form method="get" action="/authorize">${[
            ...url.searchParams,
          ]
            .filter(([k]) => !["email", "approve"].includes(k))
            .map(
              ([k, v]) =>
                `<input type="hidden" name="${escape(k)}" value="${escape(v)}">`,
            )
            .join(
              "",
            )}<input type="hidden" name="approve" value="1"><label>Demo identity<select name="email">${Object.keys(
            identities,
          )
            .map((e) => `<option>${e}</option>`)
            .join(
              "",
            )}</select></label><button>Continue to workspace</button></form></body></html>`,
        );
        return;
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const chunks = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = new URLSearchParams(Buffer.concat(chunks).toString()),
          flow = codes.get(body.get("code") ?? "");
        if (
          !flow ||
          body.get("redirect_uri") !== flow.redirect ||
          createHash("sha256")
            .update(body.get("code_verifier") ?? "")
            .digest("base64url") !== flow.challenge ||
          !(
            body.get("client_secret") === "fixture-client-secret" ||
            req.headers.authorization ===
              "Basic " +
                Buffer.from("inspector-client:fixture-client-secret").toString(
                  "base64",
                )
          )
        )
          return json({ error: "invalid_grant" }, 400);
        codes.delete(body.get("code")!);
        const fault = nextFault;
        nextFault = "";
        const idToken = await new SignJWT({
          nonce: fault === "nonce" ? "wrong-nonce" : flow.nonce,
          email: flow.email,
          email_verified: flow.email !== "unverified@example.test",
          name: identities[flow.email],
          auth_time: Math.floor(Date.now() / 1000),
          acr: "urn:inspector:test:mfa",
        })
          .setProtectedHeader({ alg: "RS256", kid: "fixture-key" })
          .setIssuer(
            fault === "issuer" ? "https://wrong-issuer.example" : origin,
          )
          .setAudience(
            fault === "audience" ? "wrong-client" : "inspector-client",
          )
          .setSubject(flow.email)
          .setIssuedAt()
          .setExpirationTime(fault === "expired" ? "-10m" : "10m")
          .sign(fault === "signature" ? wrong.privateKey : key.privateKey);
        json({
          access_token: randomUUID(),
          token_type: "Bearer",
          expires_in: 600,
          id_token: idToken,
        });
        return;
      }
      json({ error: "not_found" }, 404);
    })().catch(() => {
      res.statusCode = 500;
      res.end("Fixture failed");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    settings: {
      issuer: origin,
      clientId: "inspector-client",
      clientSecret: "fixture-client-secret",
      allowHttpForTests: true,
    },
    fault: (value: string) => {
      nextFault = value;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export async function beginLogin(origin: string, email: string) {
  const start = await fetch(origin + "/auth/login", { redirect: "manual" });
  const flowCookie = start.headers.getSetCookie()[0].split(";")[0];
  const authorize = new URL(start.headers.get("location")!);
  authorize.searchParams.set("email", email);
  authorize.searchParams.set("approve", "1");
  const approved = await fetch(authorize, { redirect: "manual" });
  return { callback: approved.headers.get("location")!, flowCookie };
}
export async function signIn(origin: string, email: string) {
  const { callback, flowCookie } = await beginLogin(origin, email);
  const response = await fetch(callback, {
    headers: { Cookie: flowCookie },
    redirect: "manual",
  });
  if (response.status !== 303)
    throw Error(
      "Fixture sign-in failed: " +
        response.status +
        " " +
        (await response.text()),
    );
  const cookie = response.headers
    .getSetCookie()
    .find((c) => c.startsWith("inspector_session="))!
    .split(";")[0];
  const session = await (
    await fetch(origin + "/api/session", { headers: { Cookie: cookie } })
  ).json();
  return {
    cookie,
    session,
    headers: {
      Cookie: cookie,
      "X-Inspector-Token": session.csrf,
      "X-Inspector-Organization":
        session.organizations[0]?.organizationId ?? "",
      "Content-Type": "application/json",
    },
  };
}
