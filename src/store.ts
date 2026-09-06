import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  projectSchema,
  type Actor,
  type Project,
  type ProjectInput,
  type PublicProject,
  type Run,
  type FindingReview,
} from "./contracts.js";
import { Database, localActor, systemActor } from "./database.js";
import { HttpError } from "./errors.js";
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function validId(id: string) {
  if (!uuid.test(id)) throw new HttpError(400, "Invalid identifier");
  return id;
}
export class Store {
  readonly database: Database;
  private ownDatabase: boolean;
  constructor(
    readonly root: string,
    readonly organizationId = "local",
    database?: Database,
  ) {
    if (organizationId !== "local") validId(organizationId);
    this.database = database ?? new Database(root);
    this.ownDatabase = !database;
    mkdirSync(join(root, "runs", organizationId), {
      recursive: true,
      mode: 0o700,
    });
  }
  close() {
    if (this.ownDatabase) this.database.close();
  }
  scope(organizationId: string) {
    return new Store(this.root, organizationId, this.database);
  }
  private scopeKey(id: string) {
    return this.organizationId + ":project:" + id;
  }
  listProjects(): PublicProject[] {
    return this.database.sql
      .prepare(
        "SELECT id,data FROM projects WHERE organization_id=? ORDER BY rowid DESC",
      )
      .all(this.organizationId)
      .map((r) =>
        this.public(
          this.database.decrypt<Project>(
            this.scopeKey(String(r.id)),
            String(r.data),
          ),
        ),
      );
  }
  private public(p: Project): PublicProject {
    return {
      ...p,
      accounts: p.accounts.map((a) => ({
        ...a,
        password: "",
        passwordConfigured: !!a.password,
      })),
    };
  }
  getProject(id: string): Project {
    const r = this.database.sql
      .prepare("SELECT data FROM projects WHERE organization_id=? AND id=?")
      .get(this.organizationId, validId(id));
    if (!r) throw new HttpError(404, "Project not found");
    return this.database.decrypt(this.scopeKey(id), String(r.data));
  }
  saveProject(
    input: ProjectInput,
    id?: string,
    demo?: Project["demo"],
    actor: Actor = localActor,
    expectedRevision?: string,
  ) {
    return this.database.transaction(() => {
      const parsed = projectSchema.parse(input),
        old = id ? this.getProject(id) : undefined;
      if (
        old &&
        expectedRevision !== undefined &&
        old.revision !== expectedRevision
      )
        throw new HttpError(
          409,
          "This configuration changed. Reload it before saving your edits.",
        );
      if (
        !old &&
        Number(
          this.database.sql
            .prepare(
              "SELECT count(*) AS n FROM projects WHERE organization_id=?",
            )
            .get(this.organizationId)?.n,
        ) >= 100
      )
        throw new HttpError(
          409,
          "This organization has reached its 100-project limit",
        );
      parsed.accounts = parsed.accounts.map((a) => ({
        ...a,
        password:
          a.password ||
          old?.accounts.find((o) => o.id === a.id)?.password ||
          "",
      }));
      if (parsed.accounts.some((a) => !a.password))
        throw new HttpError(
          400,
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
      this.database.sql
        .prepare(
          "INSERT INTO projects VALUES(?,?,?,?) ON CONFLICT(organization_id,id) DO UPDATE SET revision=excluded.revision,data=excluded.data",
        )
        .run(
          this.organizationId,
          p.id,
          p.revision,
          this.database.encrypt(this.scopeKey(p.id), p),
        );
      this.database.audit(
        this.organizationId,
        actor,
        old ? "project.updated" : "project.created",
        p.id,
        { revision: p.revision, checkCount: p.checks.length },
      );
      return this.public(p);
    });
  }
  createRun(p: Project, actor: Actor = localActor) {
    this.getProject(p.id);
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
      requestedBy: actor.name,
    };
    mkdirSync(this.runDir(run.id), { mode: 0o700 });
    this.database.transaction(() => {
      this.saveRun(run);
      this.database.audit(this.organizationId, actor, "run.requested", run.id, {
        projectId: p.id,
        revision: p.revision,
      });
    });
    return run;
  }
  runDir(id: string) {
    validId(id);
    const legacy = join(this.root, "runs", id);
    return this.organizationId === "local" &&
      existsSync(join(legacy, "run.json"))
      ? legacy
      : join(this.root, "runs", this.organizationId, id);
  }
  saveRun(run: Run) {
    this.database.transaction(() => {
      const old = this.database.sql
        .prepare("SELECT status FROM runs WHERE organization_id=? AND id=?")
        .get(this.organizationId, run.id);
      const { review: _review, hold: _hold, ...data } = run;
      this.database.sql
        .prepare(
          "INSERT INTO runs VALUES(?,?,?,?,?) ON CONFLICT(organization_id,id) DO UPDATE SET status=excluded.status,data=excluded.data",
        )
        .run(
          this.organizationId,
          validId(run.id),
          run.status,
          run.createdAt,
          JSON.stringify(data),
        );
      if (
        old &&
        old.status !== run.status &&
        !["queued", "running"].includes(run.status)
      )
        this.database.audit(
          this.organizationId,
          systemActor,
          "run." + run.status,
          run.id,
          { checked: run.results.length, total: run.total },
        );
    });
  }
  getRun(id: string): Run {
    const r = this.database.sql
      .prepare("SELECT data FROM runs WHERE organization_id=? AND id=?")
      .get(this.organizationId, validId(id));
    if (!r) throw new HttpError(404, "Run not found");
    const run: Run = JSON.parse(String(r.data));
    run.review = {};
    for (const v of this.database.sql
      .prepare(
        "SELECT result_index,data FROM reviews WHERE organization_id=? AND run_id=?",
      )
      .all(this.organizationId, id))
      run.review[String(v.result_index)] = JSON.parse(String(v.data));
    const hold = this.database.sql
      .prepare(
        "SELECT note,actor,created_at FROM run_holds WHERE organization_id=? AND run_id=?",
      )
      .get(this.organizationId, id);
    if (hold)
      run.hold = {
        note: String(hold.note),
        actor: String(hold.actor),
        createdAt: String(hold.created_at),
      };
    return run;
  }
  listRuns(limit = 100): Run[] {
    return this.database.sql
      .prepare(
        "SELECT id FROM runs WHERE organization_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?",
      )
      .all(this.organizationId, Math.min(limit, 100))
      .map((r) => this.getRun(String(r.id)));
  }
  recover() {
    for (const r of this.database.sql
      .prepare(
        "SELECT id FROM runs WHERE organization_id=? AND status IN ('queued','running')",
      )
      .all(this.organizationId)) {
      const run = this.getRun(String(r.id));
      run.status = "interrupted";
      run.finishedAt = new Date().toISOString();
      run.error =
        "The runner stopped. A new authorized run is required; actions were not replayed.";
      this.saveRun(run);
    }
  }
  review(
    id: string,
    index: number,
    input: { status: FindingReview["status"]; note: string; version: number },
    actor: Actor,
  ) {
    return this.database.transaction(() => {
      const run = this.getRun(id),
        result = run.results[index],
        old = run.review?.[String(index)];
      if (run.status !== "completed" || !result || result.status !== "failed")
        throw new HttpError(
          400,
          "Only failed checks in completed runs can be triaged",
        );
      if ((old?.version ?? 0) !== input.version)
        throw new HttpError(
          409,
          "This finding was updated by another reviewer. Reload before saving.",
        );
      const review: FindingReview = {
        status: input.status,
        note: input.note,
        actor: actor.name,
        updatedAt: new Date().toISOString(),
        version: input.version + 1,
      };
      this.database.sql
        .prepare(
          "INSERT INTO reviews VALUES(?,?,?,?) ON CONFLICT(organization_id,run_id,result_index) DO UPDATE SET data=excluded.data",
        )
        .run(this.organizationId, id, index, JSON.stringify(review));
      this.database.audit(
        this.organizationId,
        actor,
        "finding." + input.status,
        id,
        { resultIndex: index, note: input.note, version: review.version },
      );
      return review;
    });
  }
}
