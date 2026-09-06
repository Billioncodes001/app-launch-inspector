import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Access } from "./access.js";
import { memberSchema, type Actor, type Role } from "./contracts.js";
import { HttpError } from "./errors.js";
import { systemActor } from "./database.js";

const originSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.origin === value &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, "Use an exact HTTPS origin, such as https://staging.example.com, without a trailing slash");
const organizationSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    requestedOrigin: originSchema.default(""),
    requestId: z.string().uuid(),
  })
  .strict();
const inviteSchema = memberSchema.omit({ version: true });
export type Invitation = {
  id: string;
  organizationId: string;
  organizationName: string;
  email: string;
  role: Role;
  projectIds: string[];
  expiresAt: string;
};

export class Registration {
  constructor(readonly access: Access) {}
  get db() {
    return this.access.database;
  }
  create(actor: Actor, raw: unknown) {
    const input = organizationSchema.parse(raw);
    return this.db.transaction(() => {
      if (
        !this.db.sql
          .prepare("SELECT 1 FROM accounts WHERE id=? AND email=?")
          .get(actor.id, actor.email ?? "")
      )
        throw new HttpError(403, "Sign in again to verify your account");
      const old = this.db.sql
        .prepare(
          "SELECT organization_id FROM organization_registrations WHERE account_id=? AND request_id=?",
        )
        .get(actor.id, input.requestId);
      if (old) {
        this.access.assertOwner(
          this.access.member(actor, String(old.organization_id)),
        );
        return this.access.organization(String(old.organization_id));
      }
      if (
        Number(
          this.db.sql
            .prepare(
              "SELECT count(*) AS n FROM organization_registrations WHERE account_id=?",
            )
            .get(actor.id)?.n,
        ) >= 3
      )
        throw new HttpError(
          409,
          "Your account has reached its three-workspace creation limit. Contact the service operator.",
        );
      if (
        Number(
          this.db.sql.prepare("SELECT count(*) AS n FROM organizations").get()
            ?.n,
        ) >= 1000
      )
        throw new HttpError(
          429,
          "Workspace capacity reached. Contact the service operator.",
        );
      const id = randomUUID();
      this.db.sql
        .prepare("INSERT INTO organizations VALUES(?,?,'[]',?)")
        .run(id, input.name, new Date().toISOString());
      this.db.sql
        .prepare("INSERT INTO members VALUES(?,?,?,'owner','[]',1)")
        .run(id, actor.email!, actor.id);
      this.db.sql
        .prepare("INSERT INTO organization_registrations VALUES(?,?,?,?)")
        .run(id, actor.id, input.requestId, input.requestedOrigin);
      this.db.audit(id, actor, "organization.registered", id, {
        name: input.name,
        requestedOrigin: input.requestedOrigin,
      });
      return this.access.organization(id);
    });
  }
  registration(org: string) {
    const row = this.db.sql
      .prepare(
        "SELECT requested_origin FROM organization_registrations WHERE organization_id=?",
      )
      .get(org);
    return row ? { requestedOrigin: String(row.requested_origin) } : null;
  }
  approveTarget(org: string, origin: string) {
    originSchema.parse(origin);
    if (!origin) throw new HttpError(400, "Provide a target origin");
    return this.db.transaction(() => {
      const organization = this.access.organization(org);
      const origins = [...new Set([...organization.origins, origin])];
      if (origins.length > 50)
        throw new HttpError(
          409,
          "An organization can have up to fifty approved target origins",
        );
      this.db.sql
        .prepare("UPDATE organizations SET origins=? WHERE id=?")
        .run(JSON.stringify(origins), org);
      this.db.audit(org, systemActor, "target.approved", origin);
      return this.access.organization(org);
    });
  }
  private clean() {
    this.db.sql
      .prepare("DELETE FROM invitations WHERE expires_at<=?")
      .run(Date.now());
  }
  private list(where: string, value: string): Invitation[] {
    return this.db.sql
      .prepare(
        `SELECT i.*,o.name FROM invitations i JOIN organizations o ON o.id=i.organization_id WHERE ${where}=? AND i.expires_at>? ORDER BY i.expires_at`,
      )
      .all(value, Date.now())
      .map((r) => ({
        id: String(r.id),
        organizationId: String(r.organization_id),
        organizationName: String(r.name),
        email: String(r.email),
        role: r.role as Role,
        projectIds: JSON.parse(String(r.project_ids)),
        expiresAt: new Date(Number(r.expires_at)).toISOString(),
      }));
  }
  invitations(org: string, actor: Actor) {
    this.access.assertOwner(this.access.member(actor, org));
    return this.list("i.organization_id", org);
  }
  pending(actor: Actor) {
    return this.list("i.email", actor.email ?? "");
  }
  invite(org: string, actor: Actor, raw: unknown) {
    const input = inviteSchema.parse(raw);
    return this.db.transaction(() => {
      this.access.assertOwner(this.access.member(actor, org));
      this.clean();
      if (this.access.members(org).some((m) => m.email === input.email))
        throw new HttpError(
          409,
          "This person already has membership. Update their existing access instead.",
        );
      if (
        this.db.sql
          .prepare(
            "SELECT 1 FROM invitations WHERE organization_id=? AND email=?",
          )
          .get(org, input.email)
      )
        throw new HttpError(
          409,
          "An invitation is already pending. Revoke it before creating a replacement.",
        );
      if (
        this.invitations(org, actor).length + this.access.members(org).length >=
        100
      )
        throw new HttpError(
          409,
          "This organization has reached its 100-member and pending-invitation limit",
        );
      for (const id of input.projectIds)
        if (
          !this.db.sql
            .prepare("SELECT 1 FROM projects WHERE organization_id=? AND id=?")
            .get(org, id)
        )
          throw new HttpError(400, "Choose projects within this organization");
      const id = randomUUID(),
        projectIds = input.role === "owner" ? [] : input.projectIds;
      this.db.sql
        .prepare("INSERT INTO invitations VALUES(?,?,?,?,?,?,?)")
        .run(
          id,
          org,
          input.email,
          input.role,
          JSON.stringify(projectIds),
          actor.id,
          Date.now() + 7 * 86400000,
        );
      this.db.audit(org, actor, "invitation.created", id, {
        email: input.email,
        role: input.role,
        projectIds,
      });
      return this.invitations(org, actor).find((i) => i.id === id)!;
    });
  }
  revoke(org: string, actor: Actor, id: string) {
    this.access.assertOwner(this.access.member(actor, org));
    return this.db.transaction(() => {
      const row = this.db.sql
        .prepare(
          "DELETE FROM invitations WHERE organization_id=? AND id=? RETURNING email",
        )
        .get(org, z.string().uuid().parse(id));
      if (!row) throw new HttpError(404, "Invitation not found");
      this.db.audit(org, actor, "invitation.revoked", id, { email: row.email });
    });
  }
  accept(actor: Actor, id: string) {
    return this.db.transaction(() => {
      const row = this.db.sql
        .prepare(
          "SELECT * FROM invitations WHERE id=? AND email=? AND expires_at>?",
        )
        .get(z.string().uuid().parse(id), actor.email ?? "", Date.now());
      if (!row)
        throw new HttpError(
          404,
          "This invitation is unavailable, expired or intended for a different verified email",
        );
      const org = String(row.organization_id);
      const inviter = this.access
        .memberships({ id: String(row.invited_by), name: "Inviter" })
        .find((m) => m.organizationId === org);
      if (inviter?.role !== "owner")
        throw new HttpError(
          409,
          "The inviter no longer has owner access. Ask a current owner for a new invitation.",
        );
      if (this.access.members(org).some((m) => m.email === actor.email))
        throw new HttpError(
          409,
          "You already have membership. Ask an owner to revoke this pending invitation.",
        );
      this.access.saveMember(
        org,
        {
          email: actor.email!,
          role: row.role as Role,
          projectIds: JSON.parse(String(row.project_ids)),
          version: 0,
        },
        actor,
      );
      this.db.sql
        .prepare(
          "UPDATE members SET subject=? WHERE organization_id=? AND email=?",
        )
        .run(actor.id, org, actor.email!);
      this.db.sql.prepare("DELETE FROM invitations WHERE id=?").run(id);
      this.db.audit(org, actor, "invitation.accepted", id);
      return this.access.organization(org);
    });
  }
}
