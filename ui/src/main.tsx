import React, { useEffect, useId, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Clock3,
  ExternalLink,
  FileCheck2,
  FlaskConical,
  KeyRound,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Play,
  Plus,
  ScanLine,
  Settings2,
  ShieldCheck,
  Square,
  Trash2,
  Waypoints,
  X,
} from "lucide-react";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "./styles.css";
import type {
  Check as InspectionCheck,
  CheckResult,
  ProjectInput,
  PublicProject,
  Run,
  SessionInfo,
  Membership,
  FindingReview,
} from "../../src/contracts";
import { request, headers, setContext } from "./client";
import { Governance, ReviewForm } from "./governance";

async function download(run: Run, format: string) {
  const response = await fetch(`/api/runs/${run.id}/export?format=${format}`, {
    headers: headers(),
  });
  if (!response.ok) throw Error("Report could not be downloaded");
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = `inspection-${run.id}.${format}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const emptyProject: ProjectInput = {
  name: "",
  baseUrl: "",
  repository: "",
  login: {
    path: "/login",
    usernameLabel: "Email",
    passwordLabel: "Password",
    button: "Sign in",
    successPath: "/account",
    successText: "Your workspace",
    errorText: "",
  },
  accounts: [],
  checks: [
    { kind: "page", name: "Public page content", path: "/", expectedText: "" },
  ],
};
const names = {
  page: "Page content",
  login: "Sign-in",
  access: "Access boundary",
  journey: "Customer journey",
};
const icons = {
  page: FileCheck2,
  login: KeyRound,
  access: ShieldCheck,
  journey: Waypoints,
};
function time(s: string) {
  return new Date(s).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
function Badge({ status }: { status: string }) {
  return (
    <span className={"badge " + status}>
      {status === "running" ? (
        <LoaderCircle size={12} className="spin" />
      ) : (
        <span />
      )}
      {status.replaceAll("_", " ")}
    </span>
  );
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactElement;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {React.cloneElement(children as React.ReactElement<{ id: string }>, {
        id,
      })}
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}
function App({
  session,
  organization,
  onSwitch,
  onSignOut,
}: {
  session: SessionInfo;
  organization: Membership;
  onSwitch: (id: string) => void;
  onSignOut: () => void;
}) {
  const [state, setState] = useState<{
    projects: PublicProject[];
    runs: Run[];
    version: string;
    organization: Membership;
    approvedOrigins: string[];
    permissions: {
      canWrite: boolean;
      canCreate: boolean;
      canManage: boolean;
      canAcceptRisk: boolean;
    };
  }>({
    projects: [],
    runs: [],
    version: "0.2.0",
    organization,
    approvedOrigins: [],
    permissions: {
      canWrite: organization.role !== "viewer",
      canCreate:
        organization.role !== "viewer" && !organization.projectIds.length,
      canManage: organization.role === "owner",
      canAcceptRisk: organization.role === "owner",
    },
  });
  const { canWrite, canCreate, canManage, canAcceptRisk } = state.permissions;
  const hosted = session.mode === "hosted";
  const storagePrefix = "inspector-" + organization.organizationId + "-";
  const [selected, setSelected] = useState(
      () =>
        localStorage.getItem(storagePrefix + "project") ??
        (hosted ? "" : (localStorage.getItem("inspector-project") ?? "")),
    ),
    [runId, setRunId] = useState(
      () =>
        localStorage.getItem(storagePrefix + "run") ??
        (hosted ? "" : (localStorage.getItem("inspector-run") ?? "")),
    ),
    [view, setView] = useState<"workbench" | "setup" | "governance">(
      "workbench",
    );
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [loaded, setLoaded] = useState(false),
    [authorized, setAuthorized] = useState(false),
    [editing, setEditing] = useState<PublicProject | undefined>();
  const reduced = useReducedMotion();
  async function refresh() {
    try {
      const data = await request<typeof state>("/state");
      setState(data);
      setLoaded(true);
      return data;
    } catch (e) {
      setError((e as Error).message);
      setLoaded(true);
    }
  }
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 1500);
    return () => clearInterval(interval);
  }, []);
  useEffect(() => {
    localStorage.setItem(storagePrefix + "project", selected);
    localStorage.setItem(storagePrefix + "run", runId);
  }, [selected, runId]);
  const project = state.projects.find((p) => p.id === selected);
  const run = state.runs.find((r) => r.id === runId);
  const active = state.runs.filter((r) =>
    ["queued", "running"].includes(r.status),
  );
  async function act(name: string, fn: () => Promise<void>) {
    setBusy(name);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function sample(variant: "broken" | "fixed") {
    await act("sample", async () => {
      const p = await request<PublicProject>("/demo", "POST", { variant });
      const r = await request<Run>("/runs", "POST", {
        projectId: p.id,
        revision: p.revision,
        authorized: true,
      });
      setSelected(p.id);
      setRunId(r.id);
      setView("workbench");
      setAuthorized(false);
    });
  }
  function setup(p?: PublicProject) {
    setEditing(p);
    setView("setup");
    setError("");
  }
  return (
    <>
      <a className="skip" href="#main">
        Skip to inspection workbench
      </a>
      <header className="app-header">
        <a
          className="brand"
          href="#workbench"
          onClick={() => setView("workbench")}
        >
          <img src="/mark.svg" alt="" />
          Launch Inspector<span>LAB / 01</span>
        </a>
        <div className="header-right">
          {hosted && (
            <>
              <label className="organization-switch">
                <span className="sr-only">Organization workspace</span>
                <select
                  aria-label="Organization workspace"
                  value={organization.organizationId}
                  onChange={(e) => onSwitch(e.target.value)}
                >
                  {session.organizations.map((o) => (
                    <option key={o.organizationId} value={o.organizationId}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </label>
              <button className="text-button" onClick={onSignOut}>
                Sign out
              </button>
            </>
          )}
          {canManage && (
            <button
              className="workspace-controls"
              onClick={() =>
                setView(view === "governance" ? "workbench" : "governance")
              }
              aria-pressed={view === "governance"}
            >
              <Settings2 size={16} />
              {hosted ? "Organization" : "Workspace"} controls
            </button>
          )}
          <span className="local">
            <i />
            {hosted ? state.organization.role : "Local workspace"}
          </span>
          <span className="version">v{state.version}</span>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        <div className="page-heading">
          <div>
            <p className="eyebrow">SHIP WITH EVIDENCE</p>
            <h1>
              {view === "governance"
                ? "Workspace governance"
                : view === "setup"
                  ? "Configure an inspection"
                  : "Inspection workbench"}
            </h1>
            <p>
              {view === "governance"
                ? "Manage access and review the history behind inspection decisions."
                : view === "setup"
                  ? "Define your target, test accounts and the behavior you expect."
                  : "Test the paths your customers depend on. Keep the proof."}
            </p>
          </div>
          <div className="heading-actions">
            {view !== "workbench" ? (
              <button
                className="button secondary"
                onClick={() => setView("workbench")}
              >
                Back to workbench
              </button>
            ) : canCreate ? (
              <button className="button secondary" onClick={() => setup()}>
                <Plus size={16} />
                New target
              </button>
            ) : null}
          </div>
        </div>
        {error && (
          <div role="alert" className="alert">
            <CircleAlert size={18} />
            <div>
              {error}
              {error.includes("Reload") && (
                <button
                  className="text-button"
                  onClick={() => location.reload()}
                >
                  Reload workspace
                </button>
              )}
            </div>
            <button
              aria-label="Dismiss error"
              className="icon-button"
              onClick={() => setError("")}
            >
              <X size={18} />
            </button>
          </div>
        )}
        <AnimatePresence mode="wait">
          <motion.div
            key={view}
            initial={{ opacity: reduced ? 1 : 0, y: reduced ? 0 : 7 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16 }}
          >
            {view === "governance" && canManage ? (
              <Governance
                hosted={hosted}
                organization={state.organization}
                projects={state.projects}
                origins={state.approvedOrigins}
              />
            ) : view === "setup" && canWrite ? (
              <ProjectEditor
                key={editing?.id ?? "new"}
                initial={editing}
                busy={!!busy}
                onSave={(p) =>
                  act("save", async () => {
                    const saved = await request<PublicProject>(
                      editing ? "/projects/" + editing.id : "/projects",
                      editing ? "PUT" : "POST",
                      p,
                      editing
                        ? { "If-Match": '"' + editing.revision + '"' }
                        : {},
                    );
                    setSelected(saved.id);
                    setAuthorized(false);
                    setView("workbench");
                  })
                }
              />
            ) : (
              <>
                <section className="run-bar" aria-label="Start an inspection">
                  <div className="target-select">
                    <label htmlFor="project-select">Inspection target</label>
                    <select
                      id="project-select"
                      value={selected}
                      onChange={(e) => {
                        setSelected(e.target.value);
                        setAuthorized(false);
                      }}
                    >
                      <option value="">Choose a configured target</option>
                      {state.projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="target-meta">
                    {project ? (
                      <>
                        <code>{project.baseUrl}</code>
                        <span>
                          {project.checks.length} checks ·{" "}
                          {project.accounts.length} test accounts
                        </span>
                      </>
                    ) : (
                      <>
                        <code>No target selected</code>
                        <span>
                          Configure your staging app or try a controlled sample.
                        </span>
                      </>
                    )}
                  </div>
                  <button
                    className="icon-button"
                    aria-label="Edit selected target"
                    disabled={!project || !canWrite}
                    onClick={() => setup(project)}
                  >
                    <Settings2 size={19} />
                  </button>
                  <button
                    className="button"
                    disabled={!project || !authorized || !!busy || !canWrite}
                    onClick={() =>
                      act("run", async () => {
                        const r = await request<Run>("/runs", "POST", {
                          projectId: selected,
                          revision: project?.revision,
                          authorized: true,
                        });
                        setRunId(r.id);
                        setAuthorized(false);
                      })
                    }
                  >
                    {busy === "run" ? (
                      <LoaderCircle className="spin" size={16} />
                    ) : (
                      <Play size={15} />
                    )}
                    Run inspection
                  </button>
                  {project && canWrite && (
                    <label className="authorization">
                      <input
                        type="checkbox"
                        checked={authorized}
                        onChange={(e) => setAuthorized(e.target.checked)}
                      />
                      I authorize these checks on this test deployment,
                      including configured form submissions and account changes.
                    </label>
                  )}
                </section>
                <div className="workbench">
                  <aside className="run-history">
                    <div className="section-label">
                      <h2>Inspection history</h2>
                      <span>{state.runs.length}</span>
                    </div>
                    {!loaded ? (
                      <p className="empty-copy">Loading workspace…</p>
                    ) : !state.runs.length ? (
                      <div className="history-empty">
                        <Clock3 size={23} />
                        <p>No inspections yet</p>
                        <span>
                          Each run keeps its own results and screenshots.
                        </span>
                      </div>
                    ) : (
                      <div className="history-list">
                        {state.runs.map((r) => (
                          <button
                            key={r.id}
                            className={
                              "history-item " +
                              (runId === r.id ? "selected" : "")
                            }
                            onClick={() => {
                              setRunId(r.id);
                              setSelected(r.projectId);
                              setAuthorized(false);
                            }}
                          >
                            <span className="history-title">
                              {r.demo ? (
                                <FlaskConical size={15} />
                              ) : (
                                <Layers3 size={15} />
                              )}
                              <b>{r.projectName}</b>
                            </span>
                            <span className="history-detail">
                              <Badge status={r.status} />
                              <time>{time(r.createdAt)}</time>
                            </span>
                            <span className="history-counts">
                              {
                                r.results.filter((c) => c.status === "failed")
                                  .length
                              }{" "}
                              failed · {r.results.length}/{r.total} checked
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="history-foot">
                      <LockKeyhole size={14} />
                      <span>
                        Credentials encrypted at rest.
                        <br />
                        Screenshots stay in this workspace.
                      </span>
                    </div>
                  </aside>
                  <section
                    className="inspection-panel"
                    aria-label="Inspection results"
                  >
                    {run ? (
                      <RunView
                        run={run}
                        onCancel={() =>
                          act("cancel", async () => {
                            await request(`/runs/${run.id}/cancel`, "POST", {});
                          })
                        }
                        onDownload={(format) =>
                          act("download", () => download(run, format))
                        }
                        busy={!!busy}
                        canWrite={canWrite}
                        canAcceptRisk={canAcceptRisk}
                        onReview={(index, status, note, version) => {
                          void act("review", async () => {
                            await request(
                              `/runs/${run.id}/reviews/${index}`,
                              "PUT",
                              { status, note, version },
                            );
                          });
                        }}
                      />
                    ) : (
                      <div className="welcome">
                        <div className="welcome-kicker">
                          <ScanLine size={19} />
                          THE RELEASE CHECKPOINT
                        </div>
                        <h2>
                          Find the failure.
                          <br />
                          <span>Keep the evidence.</span>
                        </h2>
                        <p>
                          A successful page load is only the beginning. Verify
                          who can sign in, what each account can access, and
                          whether important changes actually persist.
                        </p>
                        <div
                          className="blueprint"
                          aria-label="Inspection flow: sign in, verify access, complete journey"
                        >
                          <div>
                            <KeyRound />
                            <b>01</b>
                            <strong>Sign in</strong>
                            <span>Confirm the session</span>
                          </div>
                          <ArrowRight className="flow-arrow" />
                          <div>
                            <ShieldCheck />
                            <b>02</b>
                            <strong>Verify access</strong>
                            <span>Test the boundary</span>
                          </div>
                          <ArrowRight className="flow-arrow" />
                          <div>
                            <Waypoints />
                            <b>03</b>
                            <strong>Complete a journey</strong>
                            <span>Prove the outcome</span>
                          </div>
                        </div>
                        {!hosted && (
                          <div className="sample-box">
                            <FlaskConical size={25} />
                            <div>
                              <h3>See an inspection in action</h3>
                              <p>
                                The sample app has real, intentional permission
                                and persistence faults. Run it, then inspect the
                                corrected version.
                              </p>
                              <div className="button-row">
                                <button
                                  className="button"
                                  disabled={!!busy}
                                  onClick={() => sample("broken")}
                                >
                                  <Play size={14} />
                                  Run faulty sample
                                </button>
                                <button
                                  className="button secondary"
                                  disabled={!!busy}
                                  onClick={() => sample("fixed")}
                                >
                                  Run corrected sample
                                  <ArrowRight size={15} />
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </section>
                </div>
                {run && !hosted && (
                  <div className="sample-shortcuts">
                    <span>
                      <FlaskConical size={16} />
                      Controlled sample apps
                    </span>
                    <button
                      className="text-button"
                      disabled={!!busy}
                      onClick={() => sample("broken")}
                    >
                      Run faulty sample
                    </button>
                    <button
                      className="text-button"
                      disabled={!!busy}
                      onClick={() => sample("fixed")}
                    >
                      Run corrected sample
                    </button>
                  </div>
                )}
              </>
            )}
          </motion.div>
        </AnimatePresence>
        <footer>
          <span>
            <ShieldCheck size={14} />
            Bounded browser checks. Human judgment remains part of release
            review.
          </span>
          <span>
            {active.length
              ? `${active.length} inspection${active.length === 1 ? "" : "s"} in progress`
              : "Runner ready"}
            <i className={active.length ? "busy-dot" : ""} />
          </span>
        </footer>
      </main>
    </>
  );
}
function RunView({
  run,
  onCancel,
  onDownload,
  busy,
  canWrite,
  canAcceptRisk,
  onReview,
}: {
  run: Run;
  onCancel: () => void;
  onDownload: (format: string) => void;
  busy: boolean;
  canWrite: boolean;
  canAcceptRisk: boolean;
  onReview: (
    index: number,
    status: FindingReview["status"],
    note: string,
    version: number,
  ) => void;
}) {
  const [index, setIndex] = useState(0);
  useEffect(
    () =>
      setIndex(
        run.status === "completed"
          ? Math.max(
              0,
              run.results.findIndex((r) => r.status === "failed"),
            )
          : 0,
      ),
    [run.id, run.status],
  );
  const result = run.results[index];
  const running = ["queued", "running"].includes(run.status);
  const failed = run.results.filter((r) => r.status === "failed").length,
    passed = run.results.filter((r) => r.status === "passed").length,
    unclear = run.results.filter((r) => r.status === "inconclusive").length;
  const title = running
    ? "Inspection in progress"
    : run.status !== "completed"
      ? "Inspection stopped"
      : failed
        ? "Findings to resolve"
        : unclear
          ? "Checks need investigation"
          : "Configured checks passed";
  return (
    <>
      <div className="report-heading">
        <div>
          <div className="report-eyebrow">
            <Badge status={run.status} />
            {run.demo && (
              <span className="demo-label">
                <FlaskConical size={13} />
                Synthetic sample
              </span>
            )}
          </div>
          <h2>{title}</h2>
          <p>
            {run.projectName} <span>·</span> {new URL(run.target).host}
          </p>
        </div>
        <div className="report-actions">
          {running ? (
            <button
              className="button secondary"
              disabled={busy || !canWrite}
              onClick={onCancel}
            >
              <Square size={13} />
              Stop run
            </button>
          ) : (
            <>
              <button
                className="button secondary small"
                disabled={busy}
                onClick={() => onDownload("md")}
              >
                <ArrowDownToLine size={15} />
                Report
              </button>
              <button
                className="icon-button"
                aria-label="Download JSON report"
                disabled={busy}
                onClick={() => onDownload("json")}
              >
                <span className="mono">{"{}"}</span>
              </button>
            </>
          )}
        </div>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-label="Checks completed"
        aria-valuenow={run.results.length}
        aria-valuemin={0}
        aria-valuemax={run.total}
      >
        <div style={{ width: `${(run.results.length / run.total) * 100}%` }} />
      </div>
      <div className="result-summary">
        <span className="positive">
          <CheckCheck size={16} />
          {passed} passed
        </span>
        <span className="negative">
          <CircleAlert size={16} />
          {failed} failed
        </span>
        <span>
          <CircleAlert size={16} />
          {unclear} inconclusive
        </span>
        <span className="checks-count">
          {run.results.length} of {run.total} checks
        </span>
      </div>
      {run.error && (
        <p className="run-error" role="alert">
          {run.error}
        </p>
      )}
      {!run.results.length ? (
        <div className="run-wait">
          <LoaderCircle size={30} className="spin" />
          <h3>
            {running ? "Opening an isolated browser" : "No completed checks"}
          </h3>
          <p>
            {running
              ? "The runner is checking the target and preparing the first scenario."
              : "Review the run message and start a new inspection when ready."}
          </p>
        </div>
      ) : (
        <div className="results-workspace">
          <div className="check-list" aria-label="Completed checks">
            {run.results.map((r, i) => {
              const Icon = icons[r.kind];
              return (
                <button
                  key={i}
                  className={"check-row " + (index === i ? "selected" : "")}
                  onClick={() => setIndex(i)}
                >
                  <span className={"check-status " + r.status}>
                    {r.status === "passed" ? (
                      <Check size={15} />
                    ) : (
                      <CircleAlert size={15} />
                    )}
                  </span>
                  <span>
                    <b>{r.name}</b>
                    <small>
                      <Icon size={12} />
                      {names[r.kind]}
                      <span>·</span>
                      {(r.durationMs / 1000).toFixed(1)}s
                    </small>
                  </span>
                  <ChevronRight size={15} />
                </button>
              );
            })}
            {running && (
              <div className="next-check">
                <LoaderCircle className="spin" size={15} />
                Running check {run.results.length + 1}…
              </div>
            )}
          </div>
          {result && (
            <FindingView
              result={result}
              run={run}
              review={
                result.status === "failed" && run.status === "completed" ? (
                  <ReviewForm
                    key={`${run.id}-${index}-${run.review?.[String(index)]?.version ?? 0}`}
                    run={run}
                    index={index}
                    busy={busy}
                    canWrite={canWrite}
                    canAcceptRisk={canAcceptRisk}
                    onSave={onReview}
                  />
                ) : undefined
              }
            />
          )}
        </div>
      )}
      <div className="run-metadata">
        <code>RUN {run.id.slice(0, 8)}</code>
        <span>{new Date(run.createdAt).toLocaleString()}</span>
        <span>Configuration {run.projectRevision.slice(0, 8)}</span>
      </div>
    </>
  );
}
function FindingView({
  result: r,
  run,
  review,
}: {
  result: CheckResult;
  run: Run;
  review?: React.ReactNode;
}) {
  return (
    <article className="finding">
      <div className="finding-title">
        <Badge status={r.status} />
        {r.status === "failed" && (
          <span className="severity">{r.severity} priority</span>
        )}
      </div>
      <h3>{r.name}</h3>
      <p className="finding-summary">{r.summary}</p>
      <dl className="observation">
        <div>
          <dt>Expected</dt>
          <dd>{r.expected}</dd>
        </div>
        <div>
          <dt>Observed</dt>
          <dd>{r.observed}</dd>
        </div>
      </dl>
      <details open>
        <summary>
          Reproduce this check
          <span>
            {r.steps.length} steps
            <ChevronDown size={14} />
          </span>
        </summary>
        <ol className="reproduction">
          {r.steps.map((step, i) => (
            <li key={i}>
              <span>{String(i + 1).padStart(2, "0")}</span>
              {step}
            </li>
          ))}
        </ol>
      </details>
      <div className="recommendation">
        <ShieldCheck size={18} />
        <div>
          <h4>
            {r.status === "passed" ? "Coverage note" : "Recommended next step"}
          </h4>
          <p>{r.recommendation}</p>
        </div>
      </div>
      {review}
      {r.warnings.map((w, i) => (
        <p className="warning" key={i}>
          <CircleAlert size={14} />
          {w}
        </p>
      ))}
      {r.screenshots.length > 0 && (
        <section className="evidence">
          <h4>
            Browser evidence <span>Inputs masked</span>
          </h4>
          <div className="evidence-grid">
            {r.screenshots.map((s) => (
              <Evidence
                key={run.id + s.file}
                run={run.id}
                file={s.file}
                label={s.label}
              />
            ))}
          </div>
        </section>
      )}
    </article>
  );
}
function Evidence({
  run,
  file,
  label,
}: {
  run: string;
  file: string;
  label: string;
}) {
  const [src, setSrc] = useState(""),
    [error, setError] = useState(false),
    [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    let url = "",
      disposed = false;
    fetch(`/api/runs/${run}/evidence/${file}`, {
      headers: headers(),
    })
      .then((r) => {
        if (!r.ok) throw Error();
        return r.blob();
      })
      .then((blob) => {
        url = URL.createObjectURL(blob);
        if (disposed) URL.revokeObjectURL(url);
        else setSrc(url);
      })
      .catch(() => {
        if (!disposed) setError(true);
      });
    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [run, file]);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  return (
    <>
      <figure>
        <button
          className="screenshot"
          onClick={() => setOpen(true)}
          disabled={!src}
          aria-label={"Enlarge " + label}
        >
          {src ? (
            <img src={src} alt={label + " from the inspected application"} />
          ) : (
            <span>
              {error ? "Evidence unavailable" : "Loading screenshot…"}
            </span>
          )}
        </button>
        <figcaption>
          {label}
          <ScanLine size={13} />
        </figcaption>
      </figure>
      <dialog ref={dialog} onCancel={() => setOpen(false)} aria-label={label}>
        <div className="dialog-heading">
          <b>{label}</b>
          <button
            className="icon-button"
            aria-label="Close screenshot"
            onClick={() => setOpen(false)}
          >
            <X size={20} />
          </button>
        </div>
        {src && <img src={src} alt={label + " enlarged"} />}
      </dialog>
    </>
  );
}
function ProjectEditor({
  initial,
  busy,
  onSave,
}: {
  initial?: PublicProject;
  busy: boolean;
  onSave: (project: ProjectInput) => void;
}) {
  const [p, setP] = useState<ProjectInput>(() =>
    initial
      ? {
          name: initial.name,
          baseUrl: initial.baseUrl,
          repository: initial.repository,
          login: { ...initial.login },
          accounts: initial.accounts.map(({ passwordConfigured, ...a }) => a),
          checks: structuredClone(initial.checks),
        }
      : structuredClone(emptyProject),
  );
  const [step, setStep] = useState(0);
  const update = (patch: Partial<ProjectInput>) => setP({ ...p, ...patch });
  const login = (key: string, value: string) =>
    update({ login: { ...p.login, [key]: value } });
  const accountOptions = p.accounts.map((a) => (
    <option key={a.id} value={a.id}>
      {a.name || a.id}
    </option>
  ));
  function newCheck(kind: InspectionCheck["kind"]): InspectionCheck {
    const base = { name: names[kind] };
    if (kind === "page") return { ...base, kind, path: "/", expectedText: "" };
    if (kind === "login")
      return {
        ...base,
        kind,
        account: p.accounts[0]?.id ?? "",
        rejectInvalid: false,
      };
    if (kind === "access")
      return {
        ...base,
        kind,
        path: "/admin",
        owner: p.accounts[0]?.id ?? "",
        actor: "anonymous",
        expectedText: "",
        deniedText: "Access denied",
      };
    return {
      ...base,
      kind,
      account: "",
      steps: [
        { action: "visit", path: "/" },
        { action: "expect", text: "" },
      ],
    };
  }
  function checkUpdate(i: number, value: InspectionCheck) {
    update({ checks: p.checks.map((c, n) => (n === i ? value : c)) });
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(p);
      }}
      className="editor"
    >
      <div
        className="editor-tabs"
        role="group"
        aria-label="Configuration sections"
      >
        {["Target & sign-in", "Test accounts", "Inspection checks"].map(
          (label, i) => (
            <button
              key={label}
              type="button"
              className={step === i ? "active" : ""}
              aria-pressed={step === i}
              onClick={() => setStep(i)}
            >
              <span>{i + 1}</span>
              {label}
              <ChevronRight size={15} />
            </button>
          ),
        )}
      </div>
      {step === 0 && (
        <div className="editor-layout">
          <section className="form-section">
            <p className="eyebrow">01 / TARGET</p>
            <h2>Where are we testing?</h2>
            <Field label="Project name">
              <input
                required
                value={p.name}
                onChange={(e) => update({ name: e.target.value })}
                placeholder="Customer portal · staging"
                maxLength={160}
              />
            </Field>
            <Field
              label="Target origin"
              hint="Use a public HTTPS staging origin or a local test app. Paths are configured per check."
            >
              <input
                required
                type="url"
                value={p.baseUrl}
                onChange={(e) => update({ baseUrl: e.target.value })}
                placeholder="https://staging.example.com"
              />
            </Field>
            <Field
              label="GitHub repository (optional)"
              hint="A reference recorded with reports. This version does not access your repository or open pull requests."
            >
              <input
                type="url"
                value={p.repository}
                onChange={(e) => update({ repository: e.target.value })}
                placeholder="https://github.com/organization/project"
              />
            </Field>
            <div className="inline-note">
              <LockKeyhole size={19} />
              <p>
                Use dedicated test accounts and disposable data. Journeys
                perform the form submissions and changes you configure.
              </p>
            </div>
          </section>
          <section className="form-section">
            <p className="eyebrow">SIGN-IN CONTRACT</p>
            <h2>Recognize a successful login</h2>
            <div className="form-grid">
              <Field label="Login path">
                <input
                  value={p.login.path}
                  onChange={(e) => login("path", e.target.value)}
                />
              </Field>
              <Field label="Signed-in path">
                <input
                  value={p.login.successPath}
                  onChange={(e) => login("successPath", e.target.value)}
                />
              </Field>
              <Field label="Username field label">
                <input
                  value={p.login.usernameLabel}
                  onChange={(e) => login("usernameLabel", e.target.value)}
                />
              </Field>
              <Field label="Password field label">
                <input
                  value={p.login.passwordLabel}
                  onChange={(e) => login("passwordLabel", e.target.value)}
                />
              </Field>
            </div>
            <Field label="Sign-in button text">
              <input
                value={p.login.button}
                onChange={(e) => login("button", e.target.value)}
              />
            </Field>
            <Field
              label="Text visible after sign-in"
              hint="Use a stable, distinctive phrase that confirms an authenticated page."
            >
              <input
                value={p.login.successText}
                onChange={(e) => login("successText", e.target.value)}
              />
            </Field>
            <Field label="Invalid-password message (optional)">
              <input
                value={p.login.errorText}
                onChange={(e) => login("errorText", e.target.value)}
              />
            </Field>
          </section>
        </div>
      )}
      {step === 1 && (
        <section className="form-section">
          <div className="section-heading">
            <div>
              <p className="eyebrow">02 / IDENTITY</p>
              <h2>Give each role its own test account</h2>
              <p className="muted">
                For ownership checks, use two ordinary users. Add an
                administrator for role-boundary checks.
              </p>
            </div>
            <button
              type="button"
              className="button secondary"
              disabled={p.accounts.length >= 6}
              onClick={() => {
                let id = 1;
                while (p.accounts.some((a) => a.id === "account-" + id)) id++;
                update({
                  accounts: [
                    ...p.accounts,
                    {
                      id: "account-" + id,
                      name: "Test account " + id,
                      username: "",
                      password: "",
                    },
                  ],
                });
              }}
            >
              <Plus size={15} />
              Add account
            </button>
          </div>
          {!p.accounts.length && (
            <div className="account-empty">
              <KeyRound size={30} />
              <p>No test accounts configured.</p>
              <span>Public page checks do not require an account.</span>
            </div>
          )}
          {p.accounts.map((a, i) => (
            <div className="account-form" key={a.id}>
              <div className="account-number">
                <KeyRound size={18} />
                <code>{a.id}</code>
              </div>
              <Field label={"Account " + (i + 1) + " name"}>
                <input
                  value={a.name}
                  onChange={(e) =>
                    update({
                      accounts: p.accounts.map((x, n) =>
                        n === i ? { ...x, name: e.target.value } : x,
                      ),
                    })
                  }
                />
              </Field>
              <Field label={"Account " + (i + 1) + " username"}>
                <input
                  value={a.username}
                  autoComplete="off"
                  onChange={(e) =>
                    update({
                      accounts: p.accounts.map((x, n) =>
                        n === i ? { ...x, username: e.target.value } : x,
                      ),
                    })
                  }
                />
              </Field>
              <Field
                label={"Account " + (i + 1) + " password"}
                hint={
                  initial?.accounts.some(
                    (x) => x.id === a.id && x.passwordConfigured,
                  )
                    ? "Saved securely. Leave blank to keep it."
                    : undefined
                }
              >
                <input
                  type="password"
                  value={a.password}
                  autoComplete="new-password"
                  onChange={(e) =>
                    update({
                      accounts: p.accounts.map((x, n) =>
                        n === i ? { ...x, password: e.target.value } : x,
                      ),
                    })
                  }
                />
              </Field>
              <button
                type="button"
                className="icon-button"
                aria-label={"Remove account " + (i + 1)}
                onClick={() =>
                  update({ accounts: p.accounts.filter((_, n) => n !== i) })
                }
              >
                <Trash2 size={17} />
              </button>
            </div>
          ))}
          <p className="hint">
            Passwords are encrypted on disk and are never returned by the
            workspace API. This release supports same-origin, labeled
            username/password forms. External SSO, MFA and CAPTCHA flows need a
            different login adapter.
          </p>
        </section>
      )}
      {step === 2 && (
        <section className="form-section checks-editor">
          <div className="section-heading">
            <div>
              <p className="eyebrow">03 / EXPECTATIONS</p>
              <h2>Define what must work</h2>
              <p className="muted">
                Every result is tied to a concrete scenario and the evidence
                observed.
              </p>
            </div>
            <button
              type="button"
              className="button secondary"
              disabled={p.checks.length >= 12}
              onClick={() =>
                update({ checks: [...p.checks, newCheck("page")] })
              }
            >
              <Plus size={15} />
              Add check
            </button>
          </div>
          {p.checks.map((c, i) => (
            <article className="check-editor" key={i}>
              <div className="check-editor-head">
                <code>CHECK {String(i + 1).padStart(2, "0")}</code>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={"Remove check " + (i + 1)}
                  disabled={p.checks.length === 1}
                  onClick={() =>
                    update({ checks: p.checks.filter((_, n) => n !== i) })
                  }
                >
                  <Trash2 size={16} />
                </button>
              </div>
              <div className="form-grid">
                <Field label={"Check " + (i + 1) + " name"}>
                  <input
                    value={c.name}
                    onChange={(e) =>
                      checkUpdate(i, { ...c, name: e.target.value })
                    }
                  />
                </Field>
                <Field label={"Check " + (i + 1) + " type"}>
                  <select
                    value={c.kind}
                    onChange={(e) =>
                      checkUpdate(
                        i,
                        newCheck(e.target.value as InspectionCheck["kind"]),
                      )
                    }
                  >
                    {Object.entries(names).map(([value, name]) => (
                      <option key={value} value={value}>
                        {name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              {c.kind === "page" && (
                <div className="form-grid">
                  <Field label="Page path">
                    <input
                      value={c.path}
                      onChange={(e) =>
                        checkUpdate(i, { ...c, path: e.target.value })
                      }
                    />
                  </Field>
                  <Field label="Expected visible text">
                    <input
                      value={c.expectedText}
                      onChange={(e) =>
                        checkUpdate(i, { ...c, expectedText: e.target.value })
                      }
                    />
                  </Field>
                </div>
              )}
              {c.kind === "login" && (
                <>
                  <Field label="Account to sign in">
                    <select
                      value={c.account}
                      onChange={(e) =>
                        checkUpdate(i, { ...c, account: e.target.value })
                      }
                    >
                      <option value="">Choose an account</option>
                      {accountOptions}
                    </select>
                  </Field>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={c.rejectInvalid}
                      onChange={(e) =>
                        checkUpdate(i, {
                          ...c,
                          rejectInvalid: e.target.checked,
                        })
                      }
                    />
                    Also attempt one invalid password and verify the configured
                    rejection message. Use an account suitable for this test.
                  </label>
                </>
              )}
              {c.kind === "access" && (
                <>
                  <div className="form-grid">
                    <Field label="Protected page path">
                      <input
                        value={c.path}
                        onChange={(e) =>
                          checkUpdate(i, { ...c, path: e.target.value })
                        }
                      />
                    </Field>
                    <Field label="Protected content marker">
                      <input
                        value={c.expectedText}
                        onChange={(e) =>
                          checkUpdate(i, { ...c, expectedText: e.target.value })
                        }
                      />
                    </Field>
                    <Field label="Account allowed to see this content">
                      <select
                        value={c.owner}
                        onChange={(e) =>
                          checkUpdate(i, { ...c, owner: e.target.value })
                        }
                      >
                        <option value="">Choose an account</option>
                        {accountOptions}
                      </select>
                    </Field>
                    <Field label="Actor that must be denied">
                      <select
                        value={c.actor}
                        onChange={(e) =>
                          checkUpdate(i, { ...c, actor: e.target.value })
                        }
                      >
                        <option value="anonymous">Signed-out visitor</option>
                        {accountOptions}
                      </select>
                    </Field>
                  </div>
                  <Field label="Expected denial text">
                    <input
                      value={c.deniedText}
                      onChange={(e) =>
                        checkUpdate(i, { ...c, deniedText: e.target.value })
                      }
                    />
                  </Field>
                  <p className="hint">
                    The allowed account establishes a positive baseline. The
                    restricted actor then uses a separate browser context.
                    Missing content alone does not prove that access was denied.
                  </p>
                </>
              )}
              {c.kind === "journey" && (
                <>
                  <Field label="Journey account">
                    <select
                      value={c.account}
                      onChange={(e) =>
                        checkUpdate(i, { ...c, account: e.target.value })
                      }
                    >
                      <option value="">Signed-out visitor</option>
                      {accountOptions}
                    </select>
                  </Field>
                  <div className="journey-steps">
                    {c.steps.map((s, j) => (
                      <div className="journey-step" key={j}>
                        <span className="step-number">{j + 1}</span>
                        <Field label={"Step " + (j + 1) + " action"}>
                          <select
                            value={s.action}
                            onChange={(e) => {
                              const action = e.target.value;
                              const next =
                                action === "visit"
                                  ? { action: "visit" as const, path: "/" }
                                  : action === "fill"
                                    ? {
                                        action: "fill" as const,
                                        label: "",
                                        value: "",
                                      }
                                    : action === "click"
                                      ? {
                                          action: "click" as const,
                                          label: "",
                                          role: "button" as const,
                                        }
                                      : { action: "expect" as const, text: "" };
                              checkUpdate(i, {
                                ...c,
                                steps: c.steps.map((x, n) =>
                                  n === j ? next : x,
                                ),
                              });
                            }}
                          >
                            <option value="visit">Visit page</option>
                            <option value="fill">Fill field</option>
                            <option value="click">Click button/link</option>
                            <option value="expect">Expect text</option>
                          </select>
                        </Field>
                        {s.action === "visit" && (
                          <Field label={"Step " + (j + 1) + " path"}>
                            <input
                              value={s.path}
                              onChange={(e) =>
                                checkUpdate(i, {
                                  ...c,
                                  steps: c.steps.map((x, n) =>
                                    n === j
                                      ? { ...s, path: e.target.value }
                                      : x,
                                  ),
                                })
                              }
                            />
                          </Field>
                        )}
                        {s.action === "expect" && (
                          <Field label={"Step " + (j + 1) + " expected text"}>
                            <input
                              value={s.text}
                              onChange={(e) =>
                                checkUpdate(i, {
                                  ...c,
                                  steps: c.steps.map((x, n) =>
                                    n === j
                                      ? { ...s, text: e.target.value }
                                      : x,
                                  ),
                                })
                              }
                            />
                          </Field>
                        )}
                        {(s.action === "fill" || s.action === "click") && (
                          <Field
                            label={
                              "Step " +
                              (j + 1) +
                              (s.action === "fill"
                                ? " field label"
                                : " control text")
                            }
                          >
                            <input
                              value={s.label}
                              onChange={(e) =>
                                checkUpdate(i, {
                                  ...c,
                                  steps: c.steps.map((x, n) =>
                                    n === j
                                      ? { ...s, label: e.target.value }
                                      : x,
                                  ),
                                })
                              }
                            />
                          </Field>
                        )}
                        {s.action === "fill" && (
                          <Field label={"Step " + (j + 1) + " value"}>
                            <input
                              value={s.value}
                              onChange={(e) =>
                                checkUpdate(i, {
                                  ...c,
                                  steps: c.steps.map((x, n) =>
                                    n === j
                                      ? { ...s, value: e.target.value }
                                      : x,
                                  ),
                                })
                              }
                            />
                          </Field>
                        )}
                        {s.action === "click" && (
                          <Field label={"Step " + (j + 1) + " control type"}>
                            <select
                              value={s.role}
                              onChange={(e) =>
                                checkUpdate(i, {
                                  ...c,
                                  steps: c.steps.map((x, n) =>
                                    n === j
                                      ? {
                                          ...s,
                                          role: e.target.value as
                                            | "button"
                                            | "link",
                                        }
                                      : x,
                                  ),
                                })
                              }
                            >
                              <option value="button">Button</option>
                              <option value="link">Link</option>
                            </select>
                          </Field>
                        )}
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={"Remove step " + (j + 1)}
                          disabled={c.steps.length === 1}
                          onClick={() =>
                            checkUpdate(i, {
                              ...c,
                              steps: c.steps.filter((_, n) => n !== j),
                            })
                          }
                        >
                          <X size={16} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="button secondary small"
                    disabled={c.steps.length >= 12}
                    onClick={() =>
                      checkUpdate(i, {
                        ...c,
                        steps: [...c.steps, { action: "expect", text: "" }],
                      })
                    }
                  >
                    <Plus size={14} />
                    Add step
                  </button>
                </>
              )}
            </article>
          ))}
        </section>
      )}
      <div className="editor-footer">
        <span>
          <LockKeyhole size={14} />
          Configuration is saved only on this computer.
        </span>
        {step < 2 ? (
          <button
            type="button"
            className="button"
            onClick={() => setStep(step + 1)}
          >
            Continue
            <ArrowRight size={15} />
          </button>
        ) : (
          <button className="button" disabled={busy}>
            {busy ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <Check size={16} />
            )}
            Save target
          </button>
        )}
      </div>
    </form>
  );
}
function WorkspaceRoot() {
  const [session, setSession] = useState<SessionInfo>(),
    [organizationId, setOrganizationId] = useState(""),
    [error, setError] = useState("");
  async function load() {
    try {
      const response = await fetch("/api/session"),
        value = (await response.json()) as SessionInfo;
      if (!response.ok) throw Error("Workspace session could not be loaded");
      const saved = localStorage.getItem("inspector-organization");
      const id =
        value.organizations.find((o) => o.organizationId === saved)
          ?.organizationId ??
        value.organizations[0]?.organizationId ??
        "";
      setContext(value, id);
      setOrganizationId(id);
      setSession(value);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
    const expire = () => {
      setSession(undefined);
      void load();
    };
    window.addEventListener("inspector-session-expired", expire);
    return () =>
      window.removeEventListener("inspector-session-expired", expire);
  }, []);
  const organization = session?.organizations.find(
    (o) => o.organizationId === organizationId,
  );
  if (session?.authenticated && organization)
    return (
      <App
        key={organizationId + session.user?.id}
        session={session}
        organization={organization}
        onSwitch={(id) => {
          setContext(session, id);
          localStorage.setItem("inspector-organization", id);
          setOrganizationId(id);
        }}
        onSignOut={() => {
          void request("/logout", "POST", {})
            .then(() => {
              setSession(undefined);
              return load();
            })
            .catch((e) => setError(e.message));
        }}
      />
    );
  return (
    <main className="signin-page">
      <div className="signin-brand">
        <img src="/mark.svg" alt="" />
        Launch Inspector
      </div>
      <section className="signin-card">
        <p className="eyebrow">THE ORGANIZATION WORKSPACE</p>
        <h1>Your release checkpoint.</h1>
        <p>
          Inspect critical application flows, review the evidence, and keep a
          clear record of every release decision.
        </p>
        {error ? (
          <div role="alert" className="alert">
            {error}
            <button
              className="text-button"
              onClick={() => {
                setError("");
                void load();
              }}
            >
              Try again
            </button>
          </div>
        ) : !session ? (
          <p>
            <LoaderCircle className="spin" size={20} />
            Connecting to your workspace…
          </p>
        ) : (
          <>
            <a className="button" href="/auth/login">
              <LockKeyhole size={17} />
              Sign in with your work account
              <ArrowRight size={17} />
            </a>
            <p className="signin-note">
              Access is managed by your organization owner. Use the verified
              email address approved for your membership.
            </p>
          </>
        )}
        <div className="signin-assurance">
          <ShieldCheck size={20} />
          <div>
            <strong>Separate organizations. Explicit access.</strong>
            <span>
              Projects, test credentials and evidence are scoped to your
              organization.
            </span>
          </div>
        </div>
      </section>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<WorkspaceRoot />);
