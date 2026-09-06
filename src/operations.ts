import { hostname } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  lstatSync,
  copyFileSync,
  constants,
  realpathSync,
} from "node:fs";
import { join, resolve, relative, sep, basename } from "node:path";
import { Database, systemActor } from "./database.js";
import { HttpError } from "./errors.js";

export function acquireLease(
  database: Database,
  onLost: () => void = () => {},
) {
  const token = randomUUID(),
    machine = hostname();
  const record = () =>
    JSON.stringify({
      token,
      pid: process.pid,
      hostname: machine,
      until: Date.now() + 90000,
    });
  database.transaction(() => {
    const row = database.sql
      .prepare("SELECT value FROM metadata WHERE key='service_lease'")
      .get();
    if (row) {
      const old = JSON.parse(String(row.value));
      let alive = false;
      if (old.hostname === machine) {
        try {
          process.kill(old.pid, 0);
          alive = true;
        } catch (e) {
          alive = (e as NodeJS.ErrnoException).code !== "ESRCH";
        }
      }
      if (alive || (old.hostname !== machine && old.until > Date.now()))
        throw new HttpError(
          409,
          "The data directory is in use. Stop the service before maintenance. A crashed container lease can take up to 90 seconds to expire.",
        );
    }
    database.sql
      .prepare(
        "INSERT INTO metadata VALUES('service_lease',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(record());
  });
  let active = true;
  const timer = setInterval(() => {
    if (!active) return;
    try {
      const update = database.sql
        .prepare(
          "UPDATE metadata SET value=? WHERE key='service_lease' AND json_extract(value,'$.token')=?",
        )
        .run(record(), token);
      if (update.changes !== 1) {
        active = false;
        clearInterval(timer);
        onLost();
      }
    } catch {
      active = false;
      clearInterval(timer);
      onLost();
    }
  }, 10000);
  timer.unref();
  return {
    get active() {
      return active;
    },
    release() {
      clearInterval(timer);
      if (active)
        database.sql
          .prepare(
            "DELETE FROM metadata WHERE key='service_lease' AND json_extract(value,'$.token')=?",
          )
          .run(token);
      active = false;
    },
  };
}
type Manifest = {
  format: 1;
  version: string;
  createdAt: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
};
function safePath(root: string, name: string) {
  if (
    !/^[A-Za-z0-9_./-]+$/.test(name) ||
    name.startsWith("/") ||
    name.split("/").some((p) => !p || p === ".." || p === ".")
  )
    throw Error("Unsafe backup path");
  const file = resolve(root, name);
  if (!file.startsWith(resolve(root) + sep))
    throw Error("Backup path leaves its directory");
  return file;
}
function filesUnder(root: string, directory: string, list: string[]) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry),
      stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw Error("Backup refuses symbolic links");
    if (stat.isDirectory()) filesUnder(root, path, list);
    else if (stat.isFile())
      list.push(relative(root, path).split(sep).join("/"));
    else throw Error("Backup encountered a non-regular file");
  }
}
export function createBackup(root: string, output: string) {
  root = resolve(root);
  output = resolve(output);
  if (
    output === root ||
    output.startsWith(root + sep) ||
    root.startsWith(output + sep) ||
    existsSync(output)
  )
    throw Error("Choose a new backup directory outside the data directory");
  const database = new Database(root);
  let lease: ReturnType<typeof acquireLease> | undefined;
  try {
    lease = acquireLease(database);
    if (
      Number(
        database.sql
          .prepare(
            "SELECT count(*) AS n FROM runs WHERE status IN ('queued','running')",
          )
          .get()?.n,
      )
    )
      throw Error(
        "Recover interrupted runs by starting and stopping the service before backup",
      );
    const organizations = [
      "local",
      ...database.sql
        .prepare("SELECT id FROM organizations")
        .all()
        .map((r) => String(r.id)),
    ];
    for (const org of organizations)
      database.audit(org, systemActor, "backup.created", "", {
        directory: basename(output),
      });
    database.sql.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    mkdirSync(output, { mode: 0o700 });
    const files = ["master.key", "inspector.sqlite"];
    if (existsSync(join(root, "projects.enc"))) files.push("projects.enc");
    if (existsSync(join(root, "runs")))
      filesUnder(root, join(root, "runs"), files);
    const manifest: Manifest = {
      format: 1,
      version: "0.4.0",
      createdAt: new Date().toISOString(),
      files: [],
    };
    for (const name of files) {
      const from = safePath(root, name),
        to = safePath(output, name);
      if (lstatSync(from).isSymbolicLink())
        throw Error("Backup refuses symbolic links");
      mkdirSync(resolve(to, ".."), { recursive: true, mode: 0o700 });
      copyFileSync(from, to, constants.COPYFILE_EXCL);
      const value = readFileSync(to);
      manifest.files.push({
        path: name,
        bytes: value.length,
        sha256: createHash("sha256").update(value).digest("hex"),
      });
    }
    writeFileSync(
      join(output, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      { flag: "wx", mode: 0o600 },
    );
    verifyBackup(output);
    return {
      directory: output,
      files: manifest.files.length,
      createdAt: manifest.createdAt,
    };
  } finally {
    lease?.release();
    database.close();
  }
}
export function verifyBackup(directory: string): Manifest {
  directory = realpathSync(directory);
  if (
    !lstatSync(join(directory, "manifest.json")).isFile() ||
    lstatSync(join(directory, "manifest.json")).isSymbolicLink()
  )
    throw Error("Backup manifest must be a regular file");
  const manifest: Manifest = JSON.parse(
    readFileSync(join(directory, "manifest.json"), "utf8"),
  );
  if (
    manifest.format !== 1 ||
    !Array.isArray(manifest.files) ||
    !manifest.files.some((f) => f.path === "master.key") ||
    !manifest.files.some((f) => f.path === "inspector.sqlite")
  )
    throw Error("Unsupported or incomplete backup manifest");
  const seen = new Set<string>();
  for (const item of manifest.files) {
    if (seen.has(item.path)) throw Error("Duplicate backup path");
    seen.add(item.path);
    const path = safePath(directory, item.path),
      actual = realpathSync(path);
    if (!actual.startsWith(directory + sep) || lstatSync(path).isSymbolicLink())
      throw Error("Backup path is not a regular file within the backup");
    const value = readFileSync(path);
    if (
      value.length !== item.bytes ||
      createHash("sha256").update(value).digest("hex") !== item.sha256
    )
      throw Error("Backup checksum mismatch: " + item.path);
  }
  return manifest;
}
export function restoreBackup(backup: string, output: string) {
  const manifest = verifyBackup(backup);
  output = resolve(output);
  if (output.startsWith(resolve(backup) + sep))
    throw Error("Restore requires a directory outside the backup");
  if (existsSync(output))
    throw Error("Restore requires a new, non-existing data directory");
  mkdirSync(output, { mode: 0o700 });
  for (const item of manifest.files) {
    const to = safePath(output, item.path);
    mkdirSync(resolve(to, ".."), { recursive: true, mode: 0o700 });
    copyFileSync(safePath(backup, item.path), to, constants.COPYFILE_EXCL);
  }
  const database = new Database(output);
  try {
    const check = database.sql.prepare("PRAGMA quick_check").get();
    if (
      check?.quick_check !== "ok" ||
      database.sql.prepare("PRAGMA foreign_key_check").all().length
    )
      throw Error("Restored database failed integrity validation");
    database.transaction(() => {
      database.sql.exec("DELETE FROM sessions; DELETE FROM auth_transactions;");
      database.sql
        .prepare("DELETE FROM metadata WHERE key='service_lease'")
        .run();
      for (const org of [
        "local",
        ...database.sql
          .prepare("SELECT id FROM organizations")
          .all()
          .map((r) => String(r.id)),
      ]) {
        if (!database.verifyAudit(org).valid)
          throw Error("Restored audit chain failed integrity validation");
        database.audit(org, systemActor, "backup.restored", "", {
          snapshotCreatedAt: manifest.createdAt,
          sessionsRevoked: true,
        });
      }
    });
    return {
      directory: output,
      files: manifest.files.length,
      sessionsRevoked: true,
    };
  } finally {
    database.close();
  }
}
