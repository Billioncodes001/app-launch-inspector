import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import {
  randomBytes,
  randomUUID,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import {
  projectSchema,
  type Project,
  type ProjectInput,
  type PublicProject,
  type Run,
} from "./contracts.js";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function validId(id: string) {
  if (!uuid.test(id)) throw new Error("Invalid identifier");
  return id;
}
export class Store {
  private key: Buffer;
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(join(root, "runs"), { recursive: true, mode: 0o700 });
    const keyPath = join(root, "master.key");
    if (!existsSync(keyPath))
      writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32) throw Error("Invalid local encryption key");
  }
  private encrypt(data: unknown) {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    return JSON.stringify({
      iv: iv.toString("base64"),
      data: Buffer.concat([
        cipher.update(JSON.stringify(data), "utf8"),
        cipher.final(),
      ]).toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    });
  }
  private decrypt(text: string) {
    const value = JSON.parse(text);
    const d = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(value.iv, "base64"),
    );
    d.setAuthTag(Buffer.from(value.tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        d.update(Buffer.from(value.data, "base64")),
        d.final(),
      ]).toString("utf8"),
    );
  }
  private atomic(path: string, data: string) {
    const temp = path + "." + randomUUID() + ".tmp";
    writeFileSync(temp, data, { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  }
  private projects(): Project[] {
    const path = join(this.root, "projects.enc");
    return existsSync(path) ? this.decrypt(readFileSync(path, "utf8")) : [];
  }
  listProjects(): PublicProject[] {
    return this.projects().map((p) => ({
      ...p,
      accounts: p.accounts.map((a) => ({
        ...a,
        password: "",
        passwordConfigured: !!a.password,
      })),
    }));
  }
  getProject(id: string) {
    const p = this.projects().find((p) => p.id === validId(id));
    if (!p) throw Error("Project not found");
    return p;
  }
  saveProject(input: ProjectInput, id?: string, demo?: Project["demo"]) {
    const parsed = projectSchema.parse(input),
      all = this.projects(),
      old = id ? this.getProject(id) : undefined;
    parsed.accounts = parsed.accounts.map((a) => ({
      ...a,
      password:
        a.password || old?.accounts.find((o) => o.id === a.id)?.password || "",
    }));
    if (parsed.accounts.some((a) => !a.password))
      throw Error(
        "Every account needs a password; blank values retain a saved password on edit",
      );
    const p: Project = {
      ...parsed,
      baseUrl: new URL(parsed.baseUrl).origin,
      id: old?.id ?? randomUUID(),
      revision: randomUUID(),
      updatedAt: new Date().toISOString(),
      ...(demo ? { demo } : {}),
    };
    this.atomic(
      join(this.root, "projects.enc"),
      this.encrypt([...all.filter((o) => o.id !== p.id), p]),
    );
    return this.listProjects().find((o) => o.id === p.id)!;
  }
  createRun(p: Project) {
    const now = new Date().toISOString();
    const run: Run = {
      id: randomUUID(),
      projectId: p.id,
      projectName: p.name,
      projectRevision: p.revision,
      target: p.baseUrl,
      repository: p.repository,
      demo: p.demo,
      status: "queued",
      createdAt: now,
      total: p.checks.length,
      results: [],
      authorizedAt: now,
    };
    mkdirSync(this.runDir(run.id), { mode: 0o700 });
    this.saveRun(run);
    return run;
  }
  runDir(id: string) {
    return join(this.root, "runs", validId(id));
  }
  saveRun(run: Run) {
    this.atomic(
      join(this.runDir(run.id), "run.json"),
      JSON.stringify(run, null, 2),
    );
  }
  getRun(id: string): Run {
    return JSON.parse(readFileSync(join(this.runDir(id), "run.json"), "utf8"));
  }
  listRuns() {
    return readdirSync(join(this.root, "runs"))
      .filter((id) => uuid.test(id))
      .map((id) => this.getRun(id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 100);
  }
  recover() {
    for (const run of this.listRuns())
      if (["queued", "running"].includes(run.status)) {
        run.status = "interrupted";
        run.finishedAt = new Date().toISOString();
        run.error =
          "The runner stopped. A new authorized run is required; actions were not replayed.";
        this.saveRun(run);
      }
  }
}
