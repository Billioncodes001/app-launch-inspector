import * as oidc from "openid-client";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Actor } from "./contracts.js";
import { Access } from "./access.js";
import { HttpError } from "./errors.js";

export type OidcSettings = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  requiredAcr?: string;
  allowHttpForTests?: boolean;
};
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export function equal(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function cookies(req: IncomingMessage) {
  return Object.fromEntries(
    (req.headers.cookie ?? "")
      .split(";")
      .map((p) => p.trim().split(/=(.*)/s).slice(0, 2))
      .filter((p) => p.length === 2),
  );
}
export class Authentication {
  private config!: oidc.Configuration;
  private limits = new Map<string, { count: number; until: number }>();
  readonly sessionName: string;
  readonly flowName: string;
  constructor(
    readonly access: Access,
    readonly origin: string,
    readonly settings: OidcSettings,
    readonly allowSignup = false,
  ) {
    this.sessionName = origin.startsWith("https:")
      ? "__Host-inspector"
      : "inspector_session";
    this.flowName = origin.startsWith("https:")
      ? "__Host-inspector_flow"
      : "inspector_flow";
  }
  async initialize() {
    const issuer = new URL(this.settings.issuer);
    if (
      issuer.protocol !== "https:" &&
      !(
        this.settings.allowHttpForTests &&
        ["127.0.0.1", "localhost"].includes(issuer.hostname)
      )
    )
      throw Error("OIDC issuer must use HTTPS");
    this.config = await oidc.discovery(
      issuer,
      this.settings.clientId,
      this.settings.clientSecret,
      undefined,
      {
        timeout: 10,
        ...(this.settings.allowHttpForTests
          ? { execute: [oidc.allowInsecureRequests] }
          : {}),
      },
    );
    oidc.enableNonRepudiationChecks(this.config);
  }
  private cookie(name: string, value: string, age: number) {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${this.origin.startsWith("https:") ? "; Secure" : ""}`;
  }
  private limit(req: IncomingMessage) {
    const now = Date.now();
    for (const [key, value] of this.limits)
      if (value.until < now) this.limits.delete(key);
    const key = req.socket.remoteAddress ?? "unknown",
      count = this.limits.get(key) ?? { count: 0, until: now + 60000 };
    if (++count.count > 30 || this.limits.size > 10000)
      throw new HttpError(429, "Too many sign-in attempts. Try again shortly.");
    this.limits.set(key, count);
  }
  async begin(req: IncomingMessage, res: ServerResponse) {
    this.limit(req);
    const state = oidc.randomState(),
      nonce = oidc.randomNonce(),
      verifier = oidc.randomPKCECodeVerifier(),
      binding = randomBytes(32).toString("hex");
    const db = this.access.database;
    db.sql
      .prepare("DELETE FROM auth_transactions WHERE created<?")
      .run(Date.now() - 600000);
    if (
      Number(
        db.sql.prepare("SELECT count(*) AS n FROM auth_transactions").get()?.n,
      ) >= 1000
    )
      throw new HttpError(429, "Sign-in capacity is temporarily full");
    db.sql.prepare("INSERT INTO auth_transactions VALUES(?,?,?,?)").run(
      digest(state),
      digest(binding),
      db.encrypt("auth-flow:" + digest(state), {
        state,
        nonce,
        verifier,
        destination:
          new URL(req.url ?? "", this.origin).searchParams.get("returnTo") ===
          "account"
            ? "/account"
            : "/",
      }),
      Date.now(),
    );
    const url = oidc.buildAuthorizationUrl(this.config, {
      redirect_uri: this.origin + "/auth/callback",
      scope: "openid email profile",
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: "S256",
      state,
      nonce,
      max_age: "3600",
      ...(this.settings.requiredAcr
        ? { acr_values: this.settings.requiredAcr }
        : {}),
    });
    res.setHeader("Set-Cookie", this.cookie(this.flowName, binding, 600));
    res.writeHead(303, { Location: url.href });
    res.end();
  }
  async callback(req: IncomingMessage, res: ServerResponse) {
    this.limit(req);
    const url = new URL(req.url ?? "", this.origin),
      state = url.searchParams.get("state") ?? "",
      binding = cookies(req)[this.flowName] ?? "";
    if (!state || state.length > 256 || !binding)
      throw new HttpError(
        400,
        "The sign-in request is missing or expired. Start again.",
      );
    const db = this.access.database;
    const row = db.transaction(() => {
      const found = db.sql
        .prepare("SELECT * FROM auth_transactions WHERE hash=?")
        .get(digest(state));
      if (
        !found ||
        Number(found.created) < Date.now() - 600000 ||
        !equal(String(found.cookie_hash), digest(binding))
      )
        throw new HttpError(
          400,
          "The sign-in request is missing or expired. Start again.",
        );
      db.sql
        .prepare("DELETE FROM auth_transactions WHERE hash=?")
        .run(digest(state));
      return found;
    });
    const flow = db.decrypt<{
      state: string;
      nonce: string;
      verifier: string;
      destination?: string;
    }>("auth-flow:" + digest(state), String(row.data));
    const tokens = await oidc.authorizationCodeGrant(this.config, url, {
      pkceCodeVerifier: flow.verifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
      maxAge: 3600,
    });
    const claims = tokens.claims();
    if (!claims)
      throw new HttpError(
        403,
        "The identity provider did not return an identity token",
      );
    if (this.settings.requiredAcr && claims.acr !== this.settings.requiredAcr)
      throw new HttpError(
        403,
        "The required sign-in assurance policy was not met",
      );
    const profile =
      typeof claims.email === "string"
        ? claims
        : await oidc.fetchUserInfo(
            this.config,
            tokens.access_token,
            claims.sub,
          );
    const actor = this.access.identity(
      this.settings.issuer,
      claims.sub,
      profile.email,
      profile.email_verified,
      profile.name,
      this.allowSignup,
    );
    const old = cookies(req)[this.sessionName];
    if (old)
      db.sql.prepare("DELETE FROM sessions WHERE hash=?").run(digest(old));
    const session = this.createSession(actor);
    res.setHeader("Set-Cookie", [
      this.cookie(this.flowName, "", 0),
      this.cookie(this.sessionName, session.token, 43200),
    ]);
    res.writeHead(303, {
      Location:
        this.origin + (flow.destination === "/account" ? "/account" : "/"),
    });
    res.end();
  }
  private createSession(actor: Actor) {
    const token = randomBytes(32).toString("hex"),
      csrf = randomBytes(32).toString("hex"),
      now = Date.now(),
      db = this.access.database;
    db.sql
      .prepare("DELETE FROM sessions WHERE created<? OR seen<?")
      .run(now - 43200000, now - 1800000);
    db.sql
      .prepare("INSERT INTO sessions VALUES(?,?,?,?,?)")
      .run(digest(token), JSON.stringify(actor), csrf, now, now);
    const old = db.sql
      .prepare(
        "SELECT hash FROM sessions WHERE json_extract(actor,'$.id')=? ORDER BY created DESC LIMIT -1 OFFSET 10",
      )
      .all(actor.id);
    for (const r of old)
      db.sql.prepare("DELETE FROM sessions WHERE hash=?").run(r.hash);
    return { token, csrf };
  }
  session(req: IncomingMessage, touch = false) {
    const token = cookies(req)[this.sessionName];
    if (!token || token.length !== 64) return undefined;
    const hash = digest(token),
      db = this.access.database,
      row = db.sql.prepare("SELECT * FROM sessions WHERE hash=?").get(hash),
      now = Date.now();
    if (!row) return undefined;
    if (
      Number(row.created) < now - 43200000 ||
      Number(row.seen) < now - 1800000
    ) {
      db.sql.prepare("DELETE FROM sessions WHERE hash=?").run(hash);
      return undefined;
    }
    if (touch)
      db.sql.prepare("UPDATE sessions SET seen=? WHERE hash=?").run(now, hash);
    return {
      actor: JSON.parse(String(row.actor)) as Actor,
      csrf: String(row.csrf),
      hash,
    };
  }
  logout(req: IncomingMessage, res: ServerResponse, actor: Actor) {
    const token = cookies(req)[this.sessionName];
    if (token)
      this.access.database.sql
        .prepare("DELETE FROM sessions WHERE hash=?")
        .run(digest(token));
    for (const m of this.access.memberships(actor))
      this.access.database.audit(m.organizationId, actor, "session.signed_out");
    res.setHeader("Set-Cookie", this.cookie(this.sessionName, "", 0));
  }
}
