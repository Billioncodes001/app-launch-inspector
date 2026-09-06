import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  ArrowRight,
  Check,
  FileCheck2,
  ShieldCheck,
  Waypoints,
  FlaskConical,
} from "lucide-react";
import type { ProjectInput, PublicProject, Run } from "../../src/contracts";
import { request } from "./client";
export function WorkspacePhoto() {
  return (
    <figure className="workspace-photo">
      <img
        src="/images/release-workspace.webp"
        alt="Application source code on an engineer’s monitor"
        width="1400"
        height="935"
      />
      <figcaption>
        Engineering, with intention.{" "}
        <a
          href="https://unsplash.com/photos/OqtafYT5kTw"
          target="_blank"
          rel="noreferrer"
        >
          Photo: Ilya Pavlov / Unsplash
        </a>
      </figcaption>
    </figure>
  );
}
export function Onboarding({
  hosted,
  canCreate,
  origins,
  verified,
  workerReady,
  defaults,
  onDone,
  onSample,
  onControls,
}: {
  hosted: boolean;
  canCreate: boolean;
  origins: string[];
  verified: string[];
  workerReady: boolean;
  defaults: ProjectInput;
  onDone: (project?: PublicProject, run?: Run) => void;
  onSample: () => Promise<void>;
  onControls?: () => void;
}) {
  const [step, setStep] = useState(0),
    [name, setName] = useState(""),
    [origin, setOrigin] = useState(origins[0] ?? ""),
    [path, setPath] = useState("/"),
    [expected, setExpected] = useState(""),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState<PublicProject>();
  const reduced = useReducedMotion(),
    heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (step) heading.current?.focus();
  }, [step]);
  const verifiedTarget = !hosted || verified.includes(origin),
    canRun = verifiedTarget && workerReady;
  const ready =
    name.trim() && origin.trim() && path.startsWith("/") && expected.trim();
  async function finish(runNow: boolean) {
    setBusy(true);
    setError("");
    try {
      const p =
        saved ??
        (await request<PublicProject>("/projects", "POST", {
          ...defaults,
          name: name.trim(),
          baseUrl: origin.trim(),
          checks: [
            {
              kind: "page",
              name: "Public page content",
              path,
              expectedText: expected.trim(),
            },
          ],
        }));
      setSaved(p);
      const run = runNow
        ? await request<Run>("/runs", "POST", {
            projectId: p.id,
            revision: p.revision,
            authorized: true,
          })
        : undefined;
      onDone(p, run);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="onboarding">
      <div className="onboarding-visual">
        <div className="onboarding-brand">
          <span className="eyebrow">LAUNCH INSPECTOR / FIELD GUIDE</span>
          <h2>
            Confidence starts
            <br />
            with evidence.
          </h2>
          <p>
            From the first page to the final release decision. Make your
            critical paths observable.
          </p>
        </div>
        <WorkspacePhoto />
        <div className="visual-foot">
          <span>01 — DEFINE</span>
          <span>02 — INSPECT</span>
          <span>03 — DECIDE</span>
        </div>
      </div>
      <div className="onboarding-content">
        <div className="onboarding-top">
          <span className="step-label">
            {step === 0 ? "YOUR RELEASE WORKSPACE" : `SETUP / ${step} OF 2`}
          </span>
          <button
            className="text-button"
            disabled={busy}
            onClick={() => onDone()}
          >
            Go to workbench
          </button>
        </div>
        <motion.div
          key={step}
          initial={{ opacity: reduced ? 1 : 0, y: reduced ? 0 : 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
        >
          <h2 ref={heading} tabIndex={-1}>
            {step === 0
              ? "Build a clearer picture of your release."
              : step === 1
                ? "Start with one important page."
                : "Your first inspection, ready to review."}
          </h2>
          {error && (
            <p role="alert" className="alert">
              {error}
            </p>
          )}
          {step === 0 ? (
            <>
              <p className="onboarding-intro">
                Check real behavior in a browser, capture what happened, and
                bring the evidence to your team.
              </p>
              <div className="onboarding-features">
                {[
                  [
                    FileCheck2,
                    "Inspect the experience",
                    "Verify page content, sign-in and customer journeys.",
                  ],
                  [
                    ShieldCheck,
                    "Check the boundaries",
                    "Use dedicated test accounts to validate access.",
                  ],
                  [
                    Waypoints,
                    "Make a recorded decision",
                    "Review findings, preserve evidence and track changes.",
                  ],
                ].map(([Icon, title, copy]) => {
                  const I = Icon as typeof FileCheck2;
                  return (
                    <div key={String(title)}>
                      <I size={20} />
                      <div>
                        <h3>{String(title)}</h3>
                        <p>{String(copy)}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="onboarding-buttons">
                {canCreate && (
                  <button className="button" onClick={() => setStep(1)}>
                    Set up my first inspection
                    <ArrowRight size={16} />
                  </button>
                )}
                {!hosted && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await onSample();
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <FlaskConical size={16} />
                    Try the working sample
                  </button>
                )}
                {!canCreate && (
                  <button className="button" onClick={() => onDone()}>
                    Explore assigned projects
                    <ArrowRight size={16} />
                  </button>
                )}
              </div>
              <p className="hint">
                {hosted
                  ? "Your company’s projects and evidence stay in its own workspace."
                  : "Start locally. The sample uses synthetic accounts and a controlled application."}
              </p>
            </>
          ) : step === 1 ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (ready) setStep(2);
              }}
            >
              <p className="onboarding-intro">
                Choose a staging application you control. We’ll visit a page and
                check for the text your customer should see.
              </p>
              <label className="field">
                Project name
                <input
                  required
                  maxLength={160}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Customer portal · staging"
                />
              </label>
              <label className="field">
                Application origin
                {hosted ? (
                  <select
                    required
                    value={origin}
                    onChange={(e) => setOrigin(e.target.value)}
                  >
                    <option value="">Choose an approved origin</option>
                    {origins.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="url"
                    required
                    value={origin}
                    onChange={(e) => setOrigin(e.target.value)}
                    placeholder="https://staging.example.com"
                  />
                )}
              </label>
              <div className="onboarding-fields">
                <label className="field">
                  Page path
                  <input
                    required
                    value={path}
                    onChange={(e) => setPath(e.target.value)}
                    placeholder="/"
                  />
                </label>
                <label className="field">
                  Expected page text
                  <input
                    required
                    maxLength={160}
                    value={expected}
                    onChange={(e) => setExpected(e.target.value)}
                    placeholder="Welcome to your workspace"
                  />
                </label>
              </div>
              <p className="hint">
                You can add sign-in checks, test accounts and journeys in the
                full target editor later.
              </p>
              <div className="control-actions">
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => setStep(0)}
                >
                  Back
                </button>
                <button className="button" disabled={!ready}>
                  Review inspection
                  <ArrowRight size={16} />
                </button>
              </div>
            </form>
          ) : (
            <>
              <p className="onboarding-intro">
                Review the scope before the browser starts. This check visits
                one page without a test account.
              </p>
              <dl className="inspection-scope">
                <div>
                  <dt>Project</dt>
                  <dd>{name}</dd>
                </div>
                <div>
                  <dt>Target page</dt>
                  <dd>
                    {origin}
                    {path}
                  </dd>
                </div>
                <div>
                  <dt>Expected text</dt>
                  <dd>{expected}</dd>
                </div>
                <div>
                  <dt>Ownership</dt>
                  <dd>
                    {hosted
                      ? verifiedTarget
                        ? "Verified for your organization"
                        : "Verification needed"
                      : "Local operator authorization"}
                  </dd>
                </div>
                <div>
                  <dt>Execution</dt>
                  <dd>{workerReady ? "Worker ready" : "Worker unavailable"}</dd>
                </div>
              </dl>
              {!verifiedTarget && (
                <p className="notice">
                  Save this target, then verify ownership in Organization
                  controls.{" "}
                  {onControls && (
                    <button className="text-button" onClick={onControls}>
                      Open target controls
                    </button>
                  )}
                </p>
              )}
              {canRun && (
                <label className="consent">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                  />
                  I am authorized to inspect this application.
                </label>
              )}
              <div className="control-actions">
                <button
                  className="button secondary"
                  disabled={busy || !!saved}
                  onClick={() => setStep(1)}
                >
                  Back
                </button>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void finish(false)}
                >
                  Save target only
                </button>
                {canRun && (
                  <button
                    className="button"
                    disabled={busy || !consent}
                    onClick={() => void finish(true)}
                  >
                    {busy ? (
                      "Starting…"
                    ) : (
                      <>
                        <Check size={16} />
                        Start first inspection
                      </>
                    )}
                  </button>
                )}
              </div>
            </>
          )}
        </motion.div>
        <div
          className="onboarding-progress"
          role="group"
          aria-label={`Setup progress: ${step} of 2 steps`}
        >
          <i className="complete" />
          <i className={step >= 1 ? "complete" : ""} />
          <i className={step >= 2 ? "complete" : ""} />
        </div>
      </div>
    </section>
  );
}
