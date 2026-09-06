import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Actor, Membership, Role } from "./contracts.js";
import { memberSchema } from "./contracts.js";
import { Database, systemActor } from "./database.js";
import { HttpError } from "./errors.js";
import { validId } from "./store.js";

export class Access {
  constructor(readonly database: Database) {}
  createOrganization(name: string, email: string, origins: string[]) {
    const input = memberSchema.parse({
      email,
      role: "owner",
      projectIds: [],
      version: 0,
    });
    name = z.string().trim().min(2).max(100).parse(name);
    if (!origins.length || origins.length > 50)
      throw new HttpError(
        400,
        "Provide between one and fifty approved target origins",
      );
    const approved = [
      ...new Set(
        origins.map((value) => {
          const u = new URL(value);
          if (
            u.username ||
            u.password ||
            u.search ||
            u.hash ||
            u.pathname !== "/" ||
            !["https:", "http:"].includes(u.protocol)
          )
            throw new HttpError(
              400,
              "Approved targets must be HTTP(S) origins",
            );
          return u.origin;
        }),
      ),
    ];
    return this.database.transaction(() => {
      const id = randomUUID();
      this.database.sql
        .prepare("INSERT INTO organizations VALUES(?,?,?,?)")
        .run(id, name, JSON.stringify(approved), new Date().toISOString());
      this.database.sql
        .prepare("INSERT INTO members VALUES(?,?,NULL,'owner','[]',1)")
        .run(id, input.email);
      this.database.audit(id, systemActor, "organization.created", id, {
        name,
        origins: approved,
        ownerEmail: input.email,
      });
      return { id, name, origins: approved };
    });
  }
  organization(id: string) {
    const row = this.database.sql
      .prepare("SELECT * FROM organizations WHERE id=?")
      .get(validId(id));
    if (!row) throw new HttpError(404, "Organization not found");
    return {
      id,
      name: String(row.name),
      origins: JSON.parse(String(row.origins)) as string[],
    };
  }
  organizations() {
    return this.database.sql
      .prepare("SELECT id FROM organizations ORDER BY created_at")
      .all()
      .map((r) => this.organization(String(r.id)));
  }
  memberships(actor: Actor): Membership[] {
    return this.database.sql
      .prepare(
        "SELECT m.*,o.name FROM members m JOIN organizations o ON o.id=m.organization_id WHERE m.subject=? ORDER BY o.name",
      )
      .all(actor.id)
      .map((r) => ({
        organizationId: String(r.organization_id),
        name: String(r.name),
        email: String(r.email),
        role: r.role as Role,
        projectIds: JSON.parse(String(r.project_ids)),
        version: Number(r.version),
      }));
  }
  member(actor: Actor, organizationId: string) {
    const member = this.memberships(actor).find(
      (m) => m.organizationId === organizationId,
    );
    if (!member)
      throw new HttpError(403, "You do not have access to this organization");
    return member;
  }
  canProject(member: Membership, id: string) {
    return (
      member.role === "owner" ||
      !member.projectIds.length ||
      member.projectIds.includes(id)
    );
  }
  assertProject(member: Membership, id: string) {
    if (!this.canProject(member, id))
      throw new HttpError(404, "Project not found");
  }
  assertWrite(member: Membership) {
    if (member.role === "viewer")
      throw new HttpError(
        403,
        "Viewer access cannot change or run inspections",
      );
  }
  assertOwner(member: Membership) {
    if (member.role !== "owner")
      throw new HttpError(403, "Organization owner access is required");
  }
  members(org: string) {
    return this.database.sql
      .prepare(
        "SELECT email,role,project_ids,version,subject FROM members WHERE organization_id=? ORDER BY email",
      )
      .all(org)
      .map((r) => ({
        email: String(r.email),
        role: r.role as Role,
        projectIds: JSON.parse(String(r.project_ids)) as string[],
        version: Number(r.version),
        activated: !!r.subject,
      }));
  }
  saveMember(org: string, raw: z.input<typeof memberSchema>, actor: Actor) {
    const input = memberSchema.parse(raw);
    return this.database.transaction(() => {
      const old = this.database.sql
        .prepare("SELECT * FROM members WHERE organization_id=? AND email=?")
        .get(org, input.email);
      if (Number(old?.version ?? 0) !== input.version)
        throw new HttpError(409, "Membership changed. Reload before saving.");
      if (old?.subject === actor.id && input.role !== "owner")
        throw new HttpError(409, "You cannot remove your own owner access");
      if (old?.role === "owner" && input.role !== "owner")
        this.keepOwner(org, String(old.subject ?? ""));
      const pending = Number(
        this.database.sql
          .prepare(
            "SELECT count(*) AS n FROM invitations WHERE organization_id=? AND email<>? AND expires_at>?",
          )
          .get(org, input.email, Date.now())?.n,
      );
      if (!old && this.members(org).length + pending >= 100)
        throw new HttpError(
          409,
          "This organization has reached its 100-member and pending-invitation limit",
        );
      for (const id of input.projectIds)
        if (
          !this.database.sql
            .prepare("SELECT 1 FROM projects WHERE organization_id=? AND id=?")
            .get(org, id)
        )
          throw new HttpError(400, "Choose projects within this organization");
      const projectIds = input.role === "owner" ? [] : input.projectIds;
      this.database.sql
        .prepare(
          "INSERT INTO members VALUES(?,?,NULL,?,?,?) ON CONFLICT(organization_id,email) DO UPDATE SET role=excluded.role,project_ids=excluded.project_ids,version=excluded.version",
        )
        .run(
          org,
          input.email,
          input.role,
          JSON.stringify(projectIds),
          input.version + 1,
        );
      this.database.audit(
        org,
        actor,
        old ? "member.updated" : "member.added",
        input.email,
        { role: input.role, projectIds },
      );
      return this.members(org).find((m) => m.email === input.email)!;
    });
  }
  removeMember(org: string, email: string, version: number, actor: Actor) {
    this.database.transaction(() => {
      const old = this.database.sql
        .prepare("SELECT * FROM members WHERE organization_id=? AND email=?")
        .get(org, email);
      if (!old) throw new HttpError(404, "Member not found");
      if (old.version !== version)
        throw new HttpError(
          409,
          "Membership changed. Reload before removing access.",
        );
      if (old.subject === actor.id)
        throw new HttpError(409, "You cannot remove your own owner access");
      if (old.role === "owner") this.keepOwner(org, String(old.subject ?? ""));
      this.database.sql
        .prepare("DELETE FROM members WHERE organization_id=? AND email=?")
        .run(org, email);
      this.database.audit(org, actor, "member.removed", email);
    });
  }
  private keepOwner(org: string, subject: string) {
    if (
      subject &&
      Number(
        this.database.sql
          .prepare(
            "SELECT count(*) AS n FROM members WHERE organization_id=? AND role='owner' AND subject IS NOT NULL AND subject<>?",
          )
          .get(org, subject)?.n,
      ) === 0
    )
      throw new HttpError(
        409,
        "Keep at least one activated owner in the organization",
      );
  }
  identity(
    issuer: string,
    subject: string,
    email: unknown,
    verified: unknown,
    name: unknown,
    allowSignup = false,
  ): Actor {
    if (
      typeof email !== "string" ||
      verified !== true ||
      typeof subject !== "string" ||
      !subject
    )
      throw new HttpError(
        403,
        "Sign-in requires a verified email address from the configured identity provider",
      );
    const address = z.string().email().max(254).parse(email).toLowerCase();
    const id = createHash("sha256")
      .update(JSON.stringify([issuer, subject]))
      .digest("hex");
    const actor: Actor = {
      id,
      name:
        typeof name === "string" && name.trim() ? name.slice(0, 160) : address,
      email: address,
    };
    return this.database.transaction(() => {
      this.database.sql
        .prepare(
          "UPDATE members SET subject=? WHERE email=? AND subject IS NULL",
        )
        .run(id, address);
      const memberships = this.memberships(actor);
      const existing = this.database.sql
        .prepare("SELECT 1 FROM accounts WHERE id=?")
        .get(id);
      const invited = this.database.sql
        .prepare("SELECT 1 FROM invitations WHERE email=? AND expires_at>?")
        .get(address, Date.now());
      if (!memberships.length && !existing && !invited && !allowSignup)
        throw new HttpError(
          403,
          "Your account has no approved organization membership",
        );
      if (
        !existing &&
        Number(
          this.database.sql.prepare("SELECT count(*) AS n FROM accounts").get()
            ?.n,
        ) >= 10000
      )
        throw new HttpError(
          429,
          "Account capacity reached. Contact the service operator.",
        );
      this.database.sql
        .prepare(
          "INSERT INTO accounts VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,name=excluded.name",
        )
        .run(id, address, actor.name, new Date().toISOString());
      for (const m of memberships)
        this.database.audit(m.organizationId, actor, "session.signed_in");
      return actor;
    });
  }
}
