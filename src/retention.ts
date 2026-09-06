import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { Store, validId } from "./store.js";
import { systemActor } from "./database.js";
import { HttpError } from "./errors.js";
import type {
  Actor,
  RetentionPolicy,
  RetentionPreview,
  Run,
} from "./contracts.js";
const daysSchema = z
  .number()
  .int()
  .refine(
    (v) => v === 0 || (v >= 7 && v <= 365),
    "Choose 7–365 days, or disable automatic cleanup",
  );
const digest = (run: Run) =>
  createHash("sha256").update(JSON.stringify(run)).digest("hex");
type Plan = {
  expires: number;
  org: string;
  days: number;
  cutoff: string;
  items: Array<{ id: string; digest: string }>;
};
export class Retention {
  constructor(readonly store: Store) {}
  policy(org: string): RetentionPolicy {
    const row = this.store.database.sql
      .prepare(
        "SELECT days,version FROM retention_policies WHERE organization_id=?",
      )
      .get(org);
    return { days: Number(row?.days ?? 0), version: Number(row?.version ?? 0) };
  }
  savePolicy(org: string, days: number, version: number, actor: Actor) {
    daysSchema.parse(days);
    return this.store.database.transaction(() => {
      if (this.policy(org).version !== version)
        throw new HttpError(
          409,
          "The retention policy changed. Reload before saving.",
        );
      this.store.database.sql
        .prepare(
          "INSERT INTO retention_policies VALUES(?,?,?) ON CONFLICT(organization_id) DO UPDATE SET days=excluded.days,version=excluded.version",
        )
        .run(org, days, version + 1);
      this.store.database.audit(org, actor, "retention.policy_updated", org, {
        days,
        version: version + 1,
      });
      return this.policy(org);
    });
  }
  hold(org: string, id: string, note: string | null, actor: Actor) {
    const run = this.store.scope(org).getRun(id);
    if (["queued", "running"].includes(run.status))
      throw new HttpError(
        409,
        "Wait for the inspection to finish before changing its retention hold",
      );
    if (note !== null) z.string().trim().min(10).max(300).parse(note);
    this.store.database.transaction(() => {
      if (note === null)
        this.store.database.sql
          .prepare("DELETE FROM run_holds WHERE organization_id=? AND run_id=?")
          .run(org, id);
      else
        this.store.database.sql
          .prepare(
            "INSERT INTO run_holds VALUES(?,?,?,?,?) ON CONFLICT(organization_id,run_id) DO UPDATE SET note=excluded.note,actor=excluded.actor,created_at=excluded.created_at",
          )
          .run(org, id, note.trim(), actor.name, new Date().toISOString());
      this.store.database.audit(
        org,
        actor,
        note === null ? "retention.hold_released" : "retention.hold_added",
        id,
        note === null ? {} : { note: note.trim() },
      );
    });
  }
  preview(org: string, days: number, actor: Actor): RetentionPreview {
    daysSchema.parse(days);
    if (days === 0)
      throw new HttpError(400, "Choose an age for the cleanup preview");
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const scoped = this.store.scope(org);
    const rows = this.store.database.sql
      .prepare(
        "SELECT id FROM runs r WHERE organization_id=? AND created_at<? AND status NOT IN ('queued','running') AND NOT EXISTS (SELECT 1 FROM run_holds h WHERE h.organization_id=r.organization_id AND h.run_id=r.id) ORDER BY created_at LIMIT 100",
      )
      .all(org, cutoff);
    const runs = rows.map((r) => scoped.getRun(String(r.id)));
    let bytes = 0;
    for (const run of runs) {
      const path = scoped.runDir(run.id);
      if (existsSync(path))
        for (const file of this.files(path)) bytes += lstatSync(file).size;
    }
    const plan: Plan = {
      org,
      days,
      cutoff,
      expires: Date.now() + 600000,
      items: runs.map((run) => ({ id: run.id, digest: digest(run) })),
    };
    return {
      token: Buffer.from(
        this.store.database.encrypt("retention:" + org + ":" + actor.id, plan),
      ).toString("base64url"),
      count: runs.length,
      bytes,
      cutoff,
      examples: runs
        .slice(0, 8)
        .map((r) => ({
          id: r.id,
          projectName: r.projectName,
          createdAt: r.createdAt,
        })),
      held: Number(
        this.store.database.sql
          .prepare(
            "SELECT count(*) AS n FROM run_holds WHERE organization_id=?",
          )
          .get(org)?.n ?? 0,
      ),
    };
  }
  execute(org: string, token: string, actor: Actor) {
    let plan: Plan;
    try {
      plan = this.store.database.decrypt<Plan>(
        "retention:" + org + ":" + actor.id,
        Buffer.from(token, "base64url").toString("utf8"),
      );
    } catch {
      throw new HttpError(
        400,
        "This cleanup preview is not valid for this account and organization",
      );
    }
    if (plan.org !== org || plan.expires < Date.now())
      throw new HttpError(
        409,
        "The cleanup preview expired. Preview it again before deleting.",
      );
    const scoped = this.store.scope(org);
    this.store.database.transaction(() => {
      for (const item of plan.items) {
        let run: Run;
        try {
          run = scoped.getRun(item.id);
        } catch {
          throw new HttpError(
            409,
            "The preview changed. Generate a fresh cleanup preview.",
          );
        }
        if (
          run.hold ||
          digest(run) !== item.digest ||
          ["queued", "running"].includes(run.status)
        )
          throw new HttpError(
            409,
            "A run changed or is on hold. Generate a fresh cleanup preview.",
          );
      }
      for (const item of plan.items) {
        const legacy =
          org === "local" &&
          scoped.runDir(item.id) === join(this.store.root, "runs", item.id);
        this.store.database.sql
          .prepare("INSERT INTO purge_jobs VALUES(?,?,?,?)")
          .run(org, item.id, legacy ? 1 : 0, new Date().toISOString());
        this.store.database.sql
          .prepare("DELETE FROM reviews WHERE organization_id=? AND run_id=?")
          .run(org, item.id);
        this.store.database.sql
          .prepare("DELETE FROM run_holds WHERE organization_id=? AND run_id=?")
          .run(org, item.id);
        this.store.database.sql
          .prepare("DELETE FROM runs WHERE organization_id=? AND id=?")
          .run(org, item.id);
      }
      if (plan.items.length)
        this.store.database.audit(org, actor, "retention.runs_deleted", org, {
          count: plan.items.length,
          runIds: plan.items.map((i) => i.id),
          cutoff: plan.cutoff,
        });
    });
    this.cleanup();
    return { deleted: plan.items.length, pendingFiles: this.pending(org) };
  }
  private files(path: string) {
    const root = realpathSync(this.store.root),
      actual = realpathSync(path);
    if (
      !actual
        .toLowerCase()
        .startsWith((root + sep + "runs" + sep).toLowerCase()) ||
      actual.toLowerCase() !== resolve(path).toLowerCase() ||
      lstatSync(path).isSymbolicLink()
    )
      throw new HttpError(
        409,
        "Evidence storage has an unsafe path; contact the operator",
      );
    return readdirSync(path).map((name) => {
      const file = join(path, name);
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new HttpError(
          409,
          "Evidence storage contains an unexpected entry; contact the operator",
        );
      return file;
    });
  }
  pending(org: string) {
    return Number(
      this.store.database.sql
        .prepare("SELECT count(*) AS n FROM purge_jobs WHERE organization_id=?")
        .get(org)?.n ?? 0,
    );
  }
  cleanup() {
    for (const row of this.store.database.sql
      .prepare("SELECT * FROM purge_jobs LIMIT 100")
      .all()) {
      const org = String(row.organization_id),
        id = validId(String(row.run_id));
      if (org !== "local") validId(org);
      const path =
        Number(row.legacy) === 1 && org === "local"
          ? join(this.store.root, "runs", id)
          : join(this.store.root, "runs", org, id);
      try {
        if (existsSync(path)) {
          for (const file of this.files(path)) unlinkSync(file);
          rmdirSync(path);
        }
        this.store.database.transaction(() => {
          this.store.database.sql
            .prepare(
              "DELETE FROM purge_jobs WHERE organization_id=? AND run_id=?",
            )
            .run(org, id);
          this.store.database.audit(
            org,
            systemActor,
            "retention.evidence_deleted",
            id,
          );
        });
      } catch {
        /* Keep the durable tombstone so access stays revoked and cleanup can retry. */
      }
    }
  }
  sweep() {
    this.cleanup();
    for (const row of this.store.database.sql
      .prepare(
        "SELECT organization_id,days FROM retention_policies WHERE days>0",
      )
      .all()) {
      const org = String(row.organization_id);
      try {
        const preview = this.preview(org, Number(row.days), systemActor);
        if (preview.count) this.execute(org, preview.token, systemActor);
      } catch {
        console.error(
          JSON.stringify({
            event: "retention.cleanup_failed",
            organizationId: org,
          }),
        );
      }
    }
  }
}
