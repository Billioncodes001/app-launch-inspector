import { useEffect, useState } from "react";
import {
  Users,
  ScrollText,
  ShieldCheck,
  LoaderCircle,
  Download,
  Pencil,
  X,
  UserPlus,
} from "lucide-react";
import type {
  AuditEntry,
  FindingReview,
  Membership,
  PublicProject,
  Run,
  Role,
} from "../../src/contracts";
import { TargetsPanel, RetentionPanel } from "./controls";
import { request } from "./client";
type Member = {
  email: string;
  role: Role;
  projectIds: string[];
  version: number;
  activated: boolean;
};
type AuditPage = {
  entries: AuditEntry[];
  next: number | null;
  integrity: { valid: boolean; count: number; head: string };
};
export function Governance({
  hosted,
  organization,
  projects,
  origins,
}: {
  hosted: boolean;
  organization: Membership;
  projects: PublicProject[];
  origins: string[];
}) {
  const [tab, setTab] = useState(hosted ? "people" : "audit");
  const [members, setMembers] = useState<Member[]>([]),
    [audit, setAudit] = useState<AuditPage>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{
    email: string;
    role: Role;
    projectIds: string[];
    version: number;
  }>({ email: "", role: "viewer", projectIds: [], version: 0 });
  const [limited, setLimited] = useState(false),
    [remove, setRemove] = useState<Member>();
  async function load() {
    try {
      setError("");
      if (tab === "people") setMembers(await request<Member[]>("/members"));
      else if (tab === "audit") setAudit(await request<AuditPage>("/audit"));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, [tab]);
  async function save() {
    setBusy(true);
    setError("");
    try {
      if (limited && !draft.projectIds.length)
        throw Error("Select at least one project for restricted access");
      await request("/members", "PUT", {
        ...draft,
        projectIds: limited ? draft.projectIds : [],
      });
      setDraft({ email: "", role: "viewer", projectIds: [], version: 0 });
      setLimited(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function exportAudit() {
    const blob = new Blob([JSON.stringify(audit, null, 2)], {
        type: "application/json",
      }),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = "audit-" + organization.organizationId + ".json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="governance">
      <nav
        className="governance-tabs"
        aria-label="Organization control sections"
      >
        {hosted && (
          <button
            onClick={() => setTab("people")}
            aria-pressed={tab === "people"}
          >
            <Users size={16} />
            People & access
          </button>
        )}
        <button onClick={() => setTab("audit")} aria-pressed={tab === "audit"}>
          <ScrollText size={16} />
          Audit history
        </button>
        {hosted && (
          <button
            onClick={() => setTab("targets")}
            aria-pressed={tab === "targets"}
          >
            <ShieldCheck size={16} />
            Verified targets
          </button>
        )}
        <button
          onClick={() => setTab("retention")}
          aria-pressed={tab === "retention"}
        >
          Evidence retention
        </button>
      </nav>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {tab === "targets" ? (
        <TargetsPanel />
      ) : tab === "retention" ? (
        <RetentionPanel />
      ) : tab === "people" ? (
        <div className="governance-grid">
          <div className="control-card">
            <div className="control-heading">
              <div>
                <p className="eyebrow">ORGANIZATION DIRECTORY</p>
                <h2>People with access</h2>
              </div>
              <span className="count-chip">{members.length}</span>
            </div>
            <p className="control-copy">
              Members sign in through the configured identity provider with
              their verified work email. Adding a member grants access; it does
              not send an email.
            </p>
            <div className="member-list">
              {members.map((m) => (
                <div className="member-row" key={m.email}>
                  <div className="member-avatar" aria-hidden="true">
                    {m.email.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="member-identity">
                    <strong>{m.email}</strong>
                    <span>
                      {m.role} ·{" "}
                      {m.activated ? "Activated" : "Awaiting first sign-in"} ·{" "}
                      {m.projectIds.length
                        ? `${m.projectIds.length} projects`
                        : "All projects"}
                    </span>
                  </div>
                  <button
                    className="icon-button"
                    aria-label={`Edit ${m.email}`}
                    onClick={() => {
                      setDraft({
                        email: m.email,
                        role: m.role,
                        projectIds: m.projectIds,
                        version: m.version,
                      });
                      setLimited(!!m.projectIds.length);
                    }}
                  >
                    <Pencil size={15} />
                  </button>
                  {m.email !== organization.email && (
                    <button
                      className="icon-button"
                      aria-label={`Remove ${m.email}`}
                      onClick={() => setRemove(m)}
                    >
                      <X size={16} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {remove && (
              <div className="remove-confirm" role="alert">
                <p>
                  Remove <strong>{remove.email}</strong> from this organization?
                  Their current session will lose access to this workspace.
                </p>
                <button
                  className="button secondary"
                  onClick={() => setRemove(undefined)}
                >
                  Keep access
                </button>
                <button
                  className="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await request("/members", "DELETE", {
                        email: remove.email,
                        version: remove.version,
                      });
                      setRemove(undefined);
                      await load();
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Remove access
                </button>
              </div>
            )}
          </div>
          <div className="control-card">
            <h2>{draft.version ? "Update access" : "Add a team member"}</h2>
            <form
              className="member-form"
              onSubmit={(e) => {
                e.preventDefault();
                void save();
              }}
            >
              <label>
                Work email
                <input
                  type="email"
                  required
                  maxLength={254}
                  value={draft.email}
                  readOnly={!!draft.version}
                  onChange={(e) =>
                    setDraft({ ...draft, email: e.target.value })
                  }
                />
              </label>
              <label>
                Organization role
                <select
                  value={draft.role}
                  onChange={(e) => {
                    const role = e.target.value as Role;
                    setDraft({ ...draft, role });
                    if (role === "owner") setLimited(false);
                  }}
                >
                  <option value="viewer">
                    Viewer — read projects and reports
                  </option>
                  <option value="editor">
                    Editor — configure, run and investigate
                  </option>
                  <option value="owner">
                    Owner — manage access and accept risk
                  </option>
                </select>
              </label>
              {draft.role !== "owner" && (
                <>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={limited}
                      onChange={(e) => setLimited(e.target.checked)}
                    />
                    Restrict to selected projects
                  </label>
                  {limited && (
                    <fieldset>
                      <legend>Projects this member can access</legend>
                      {projects.length ? (
                        projects.map((p) => (
                          <label className="check-label" key={p.id}>
                            <input
                              type="checkbox"
                              checked={draft.projectIds.includes(p.id)}
                              onChange={(e) =>
                                setDraft({
                                  ...draft,
                                  projectIds: e.target.checked
                                    ? [...draft.projectIds, p.id]
                                    : draft.projectIds.filter(
                                        (id) => id !== p.id,
                                      ),
                                })
                              }
                            />
                            {p.name}
                          </label>
                        ))
                      ) : (
                        <p>
                          Create a project before assigning restricted access.
                        </p>
                      )}
                    </fieldset>
                  )}
                </>
              )}
              <button className="button" disabled={busy}>
                {busy ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <UserPlus size={15} />
                )}
                {draft.version ? "Save access" : "Add member"}
              </button>
              {!!draft.version && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setDraft({
                      email: "",
                      role: "viewer",
                      projectIds: [],
                      version: 0,
                    });
                    setLimited(false);
                  }}
                >
                  Cancel editing
                </button>
              )}
            </form>
            <div className="target-policy">
              <ShieldCheck size={18} />
              <div>
                <h3>Approved inspection targets</h3>
                <p>
                  The service operator controls this list for your organization.
                </p>
                {origins.map((o) => (
                  <code key={o}>{o}</code>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="control-card audit-card">
          <div className="control-heading">
            <div>
              <p className="eyebrow">ACCOUNTABILITY</p>
              <h2>Workspace audit history</h2>
            </div>
            <button
              className="button secondary small"
              onClick={exportAudit}
              disabled={!audit}
            >
              <Download size={15} />
              Export loaded entries
            </button>
          </div>
          <p className="control-copy">
            Configuration changes, sign-ins, membership changes, run activity,
            report exports and review decisions are recorded with an actor and
            timestamp.
          </p>
          {audit && (
            <div
              className={
                "integrity " + (audit.integrity.valid ? "valid" : "invalid")
              }
            >
              <ShieldCheck size={16} />
              <span>
                {audit.integrity.valid
                  ? "Integrity check passed"
                  : "Audit integrity check failed"}{" "}
                · {audit.integrity.count} recorded events
              </span>
              <small>
                A cryptographic chain detects modified entries. This is not an
                external immutable archive.
              </small>
            </div>
          )}
          <div className="audit-list">
            {audit?.entries.map((entry) => (
              <article className="audit-row" key={entry.sequence}>
                <span className="audit-sequence">
                  {String(entry.sequence).padStart(3, "0")}
                </span>
                <div>
                  <h3>
                    {entry.action.replaceAll(".", " / ").replaceAll("_", " ")}
                  </h3>
                  <p>
                    {entry.actor} <span>·</span>{" "}
                    {new Date(entry.at).toLocaleString()}
                  </p>
                  {entry.resource && <code>{entry.resource}</code>}
                  {Object.keys(entry.details).length > 0 && (
                    <details>
                      <summary>Event details</summary>
                      <pre>{JSON.stringify(entry.details, null, 2)}</pre>
                    </details>
                  )}
                </div>
              </article>
            ))}
          </div>
          {audit && !audit.entries.length && (
            <p className="empty-copy">
              Events will appear when someone configures a target or runs an
              inspection.
            </p>
          )}
          {audit?.next && (
            <button
              className="button secondary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const page = await request<AuditPage>(
                    "/audit?before=" + audit.next,
                  );
                  setAudit({
                    ...page,
                    entries: [...audit.entries, ...page.entries],
                  });
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Load older events
            </button>
          )}
        </div>
      )}
    </section>
  );
}
export function ReviewForm({
  run,
  index,
  canWrite,
  canAcceptRisk,
  busy,
  onSave,
}: {
  run: Run;
  index: number;
  canWrite: boolean;
  canAcceptRisk: boolean;
  busy: boolean;
  onSave: (
    index: number,
    status: FindingReview["status"],
    note: string,
    version: number,
  ) => void;
}) {
  const current = run.review?.[String(index)];
  const [status, setStatus] = useState<FindingReview["status"]>(
      current?.status ?? "investigating",
    ),
    [note, setNote] = useState(current?.note ?? "");
  return (
    <section className="finding-review">
      <h4>Review decision</h4>
      {current ? (
        <div className="review-record">
          <strong>{current.status.replaceAll("_", " ")}</strong>
          <p>{current.note}</p>
          <span>
            {current.actor} · {new Date(current.updatedAt).toLocaleString()}
          </span>
        </div>
      ) : (
        <p>This finding has not been triaged.</p>
      )}
      <p className="hint">
        Review decisions preserve the original result. Accepting a risk does not
        make the check pass.
      </p>
      {canWrite && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave(index, status, note, current?.version ?? 0);
          }}
        >
          <label>
            Review status
            <select
              value={status}
              onChange={(e) =>
                setStatus(e.target.value as FindingReview["status"])
              }
            >
              <option value="open">Open</option>
              <option value="investigating">Investigating</option>
              <option value="accepted_risk" disabled={!canAcceptRisk}>
                Risk accepted (owner only)
              </option>
            </select>
          </label>
          <label>
            Review note
            <textarea
              required
              minLength={10}
              maxLength={1000}
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Record the reason and the next action."
            />
          </label>
          <button
            className="button secondary small"
            disabled={busy || (status === "accepted_risk" && !canAcceptRisk)}
          >
            Save review
          </button>
        </form>
      )}
    </section>
  );
}
