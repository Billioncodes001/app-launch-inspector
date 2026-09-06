import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHmac,
} from "node:crypto";
import type { Actor, AuditEntry, Project, Run } from "./contracts.js";

export const systemActor: Actor = { id: "system", name: "Inspection service" };
export const localActor: Actor = { id: "local", name: "Local owner" };
export class Database {
  readonly sql: DatabaseSync;
  private key: Buffer;
  private depth = 0;
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const keyPath = join(root, "master.key");
    if (!existsSync(keyPath))
      writeFileSync(keyPath, randomBytes(32), { flag: "wx", mode: 0o600 });
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw Error("Invalid local encryption key");
    this.sql = new DatabaseSync(join(root, "inspector.sqlite"));
    if (
      Number(this.sql.prepare("PRAGMA user_version").get()?.user_version) > 2
    ) {
      this.sql.close();
      throw Error("This database requires a newer Launch Inspector version");
    }
    chmodSync(join(root, "inspector.sqlite"), 0o600);
    this.sql
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL, origins TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS members (organization_id TEXT NOT NULL REFERENCES organizations(id), email TEXT NOT NULL, subject TEXT, role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')), project_ids TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL, PRIMARY KEY(organization_id,email));
      CREATE INDEX IF NOT EXISTS members_subject ON members(subject);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, actor TEXT NOT NULL, csrf TEXT NOT NULL, created INTEGER NOT NULL, seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_transactions (hash TEXT PRIMARY KEY, cookie_hash TEXT NOT NULL, data TEXT NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS projects (organization_id TEXT NOT NULL, id TEXT NOT NULL, revision TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(organization_id,id));
      CREATE TABLE IF NOT EXISTS runs (organization_id TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(organization_id,id));
      CREATE INDEX IF NOT EXISTS runs_history ON runs(organization_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS reviews (organization_id TEXT NOT NULL, run_id TEXT NOT NULL, result_index INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(organization_id,run_id,result_index), FOREIGN KEY(organization_id,run_id) REFERENCES runs(organization_id,id));
      CREATE TABLE IF NOT EXISTS audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, organization_id TEXT NOT NULL, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, resource TEXT NOT NULL, details TEXT NOT NULL, previous_hash TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_org ON audit(organization_id,sequence DESC);
    `);
    try {
      this.importLegacy();
      this.sql.exec("PRAGMA user_version=2");
    } catch (error) {
      this.sql.close();
      throw error;
    }
  }
  close() {
    this.sql.close();
  }
  transaction<T>(fn: () => T): T {
    if (this.depth) return fn();
    this.sql.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const value = fn();
      this.sql.exec("COMMIT");
      return value;
    } catch (error) {
      this.sql.exec("ROLLBACK");
      throw error;
    } finally {
      this.depth--;
    }
  }
  private scopedKey(scope: string) {
    return createHmac("sha256", this.key)
      .update("launch-inspector:" + scope)
      .digest();
  }
  encrypt(scope: string, value: unknown) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.scopedKey(scope), iv);
    cipher.setAAD(Buffer.from(scope));
    const data = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
    ]);
    return JSON.stringify({
      iv: iv.toString("base64"),
      data: data.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    });
  }
  decrypt<T>(scope: string, encoded: string): T {
    const value = JSON.parse(encoded),
      cipher = createDecipheriv(
        "aes-256-gcm",
        this.scopedKey(scope),
        Buffer.from(value.iv, "base64"),
      );
    cipher.setAAD(Buffer.from(scope));
    cipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        cipher.update(Buffer.from(value.data, "base64")),
        cipher.final(),
      ]).toString("utf8"),
    );
  }
  audit(
    org: string,
    actor: Actor,
    action: string,
    resource = "",
    details: Record<string, unknown> = {},
  ) {
    return this.transaction(() => {
      const previous =
        (this.sql
          .prepare(
            "SELECT hash FROM audit WHERE organization_id=? ORDER BY sequence DESC LIMIT 1",
          )
          .get(org)?.hash as string) ?? "";
      const at = new Date().toISOString(),
        person = actor.name.slice(0, 160),
        encoded = JSON.stringify(details);
      const hash = createHmac("sha256", this.scopedKey("audit:" + org))
        .update(
          JSON.stringify([
            previous,
            at,
            actor.id,
            person,
            action,
            resource,
            encoded,
          ]),
        )
        .digest("hex");
      this.sql
        .prepare(
          "INSERT INTO audit(organization_id,at,actor,action,resource,details,previous_hash,hash) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          org,
          at,
          JSON.stringify({ id: actor.id, name: person }),
          action,
          resource,
          encoded,
          previous,
          hash,
        );
    });
  }
  auditEntries(
    org: string,
    before = Number.MAX_SAFE_INTEGER,
    limit = 100,
  ): AuditEntry[] {
    return this.sql
      .prepare(
        "SELECT * FROM audit WHERE organization_id=? AND sequence<? ORDER BY sequence DESC LIMIT ?",
      )
      .all(org, before, limit)
      .map((r) => ({
        sequence: Number(r.sequence),
        at: String(r.at),
        actor: JSON.parse(String(r.actor)).name,
        action: String(r.action),
        resource: String(r.resource),
        details: JSON.parse(String(r.details)),
        hash: String(r.hash),
      }));
  }
  verifyAudit(org: string) {
    let previous = "",
      count = 0;
    for (const r of this.sql
      .prepare("SELECT * FROM audit WHERE organization_id=? ORDER BY sequence")
      .iterate(org)) {
      const actor = JSON.parse(String(r.actor));
      const hash = createHmac("sha256", this.scopedKey("audit:" + org))
        .update(
          JSON.stringify([
            previous,
            r.at,
            actor.id,
            actor.name,
            r.action,
            r.resource,
            r.details,
          ]),
        )
        .digest("hex");
      if (r.previous_hash !== previous || r.hash !== hash)
        return { valid: false, count, head: previous };
      previous = hash;
      count++;
    }
    return { valid: true, count, head: previous };
  }
  private importLegacy() {
    if (
      this.sql
        .prepare("SELECT value FROM metadata WHERE key='legacy_imported'")
        .get()
    )
      return;
    this.transaction(() => {
      if (
        this.sql
          .prepare("SELECT value FROM metadata WHERE key='legacy_imported'")
          .get()
      )
        return;
      let projects: Project[] = [],
        runs = 0;
      const path = join(this.root, "projects.enc");
      if (existsSync(path)) {
        const v = JSON.parse(readFileSync(path, "utf8")),
          d = createDecipheriv(
            "aes-256-gcm",
            this.key,
            Buffer.from(v.iv, "base64"),
          );
        d.setAuthTag(Buffer.from(v.tag, "base64"));
        projects = JSON.parse(
          Buffer.concat([
            d.update(Buffer.from(v.data, "base64")),
            d.final(),
          ]).toString(),
        );
      }
      for (const p of projects)
        this.sql
          .prepare("INSERT INTO projects VALUES(?,?,?,?)")
          .run(
            "local",
            p.id,
            p.revision,
            this.encrypt("local:project:" + p.id, p),
          );
      const runRoot = join(this.root, "runs");
      if (existsSync(runRoot))
        for (const id of readdirSync(runRoot)) {
          if (
            !/^[0-9a-f-]{36}$/.test(id) ||
            !existsSync(join(runRoot, id, "run.json"))
          )
            continue;
          const r: Run = JSON.parse(
            readFileSync(join(runRoot, id, "run.json"), "utf8"),
          );
          if (r.id !== id)
            throw Error("Legacy run identifier does not match its directory");
          this.sql
            .prepare("INSERT INTO runs VALUES(?,?,?,?,?)")
            .run("local", id, r.status, r.createdAt, JSON.stringify(r));
          runs++;
        }
      this.sql
        .prepare("INSERT INTO metadata VALUES('legacy_imported',?)")
        .run(new Date().toISOString());
      if (projects.length || runs)
        this.audit("local", systemActor, "storage.migrated", "", {
          projects: projects.length,
          runs,
          legacyFilesPreserved: true,
        });
    });
  }
}
