import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ShieldCheck,
  Copy,
  ArrowRight,
  Archive,
  X,
  LoaderCircle,
} from "lucide-react";
import type {
  TargetProof,
  RetentionPolicy,
  RetentionPreview,
  Run,
} from "../../src/contracts";
import { request } from "./client";

export function TargetsPanel({ organizationId }: { organizationId?: string }) {
  const [targets, setTargets] = useState<TargetProof[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [message, setMessage] = useState("");
  async function load() {
    setTargets(await request<TargetProof[]>("/targets"));
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  async function act(
    target: TargetProof,
    action: "challenge" | "verify",
    method?: "https" | "dns",
  ) {
    setBusy(target.origin);
    setError("");
    setMessage("");
    try {
      await request("/targets/" + action, "POST", {
        origin: target.origin,
        version: target.version,
        ...(method ? { method } : {}),
      });
      await load();
      if (action === "verify")
        setMessage(
          "Ownership verified for 30 days. This target is ready for inspections.",
        );
    } catch (e) {
      setError((e as Error).message);
      await load().catch(() => undefined);
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="control-card">
      <p className="eyebrow">TARGET OWNERSHIP</p>
      <h2>Verify before you inspect</h2>
      <p className="control-copy">
        The operator approves each exact origin. Your organization then proves
        control with a DNS record or a public verification file. Verification
        lasts 30 days; renew it here before it expires.
      </p>
      {error && (
        <p className="alert" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="notice" role="status">
          {message}
        </p>
      )}
      {!targets.length && (
        <div className="empty-copy">
          <p>
            Ask your service operator to approve your staging origin to begin.
          </p>
          {organizationId && (
            <label className="account-reference">
              Organization reference
              <input value={organizationId} readOnly />
            </label>
          )}
        </div>
      )}
      {targets.map((t) => (
        <article className="target-proof" key={t.origin}>
          <div className="control-heading">
            <h3>{t.origin}</h3>
            <span
              className={
                "badge " + (t.status === "verified" ? "passed" : "inconclusive")
              }
            >
              {t.status}
            </span>
          </div>
          {t.verifiedUntil && (
            <p className="hint">
              Valid until {new Date(t.verifiedUntil).toLocaleString()}
            </p>
          )}
          {t.value ? (
            <>
              <div className="proof-instructions">
                <div>
                  <span className="step-label">01 / PUBLISH ONE PROOF</span>
                  <p>
                    Serve this value at <code>{t.origin + t.filePath}</code>, or
                    add a TXT record at <code>{t.recordName}</code>.
                  </p>
                  <p className="hint">
                    Use HTTPS with a 200 response and no redirect. Leave the
                    record in place to renew. New challenges expire after 24
                    hours.
                  </p>
                </div>
                <div className="proof-value">
                  <code>{t.value}</code>
                  <button
                    className="button secondary small"
                    aria-label={"Copy proof for " + t.origin}
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(t.value!)
                        .then(() => setMessage("Verification value copied."))
                        .catch(() =>
                          setError(
                            "Copy unavailable. Select and copy the value above.",
                          ),
                        )
                    }
                  >
                    <Copy size={14} />
                    Copy value
                  </button>
                </div>
              </div>
              <div className="control-actions">
                <span className="step-label">02 / CHECK OWNERSHIP</span>
                <button
                  className="button secondary small"
                  disabled={!!busy}
                  onClick={() => void act(t, "verify", "https")}
                >
                  {busy === t.origin ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <ShieldCheck size={15} />
                  )}
                  Verify file
                </button>
                <button
                  className="button secondary small"
                  disabled={!!busy}
                  onClick={() => void act(t, "verify", "dns")}
                >
                  Verify DNS
                </button>
                {t.status !== "verified" && (
                  <button
                    className="text-button"
                    disabled={!!busy}
                    onClick={() => void act(t, "challenge")}
                  >
                    Replace challenge
                  </button>
                )}
              </div>
            </>
          ) : (
            <button
              className="button secondary"
              disabled={!!busy}
              onClick={() => void act(t, "challenge")}
            >
              Create verification challenge
              <ArrowRight size={15} />
            </button>
          )}
        </article>
      ))}
    </div>
  );
}

export function RetentionPanel() {
  const [policy, setPolicy] = useState<RetentionPolicy>(),
    [days, setDays] = useState(30),
    [automatic, setAutomatic] = useState(false),
    [preview, setPreview] = useState<RetentionPreview>(),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [open, setOpen] = useState(false),
    [confirm, setConfirm] = useState("");
  async function load() {
    const data = await request<{
      policy: RetentionPolicy;
      pendingFiles: number;
    }>("/retention");
    setPolicy(data.policy);
    setAutomatic(data.policy.days > 0);
    if (data.policy.days) setDays(data.policy.days);
    if (data.pendingFiles)
      setMessage(
        `${data.pendingFiles} evidence folders are awaiting another cleanup attempt. Access is already revoked.`,
      );
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="governance-grid">
      <section className="control-card">
        <p className="eyebrow">EVIDENCE LIFECYCLE</p>
        <h2>Keep what matters</h2>
        <p className="control-copy">
          Finished inspections can be removed after a chosen age. A retention
          hold protects an individual report and its screenshots. Projects and
          audit history are preserved.
        </p>
        {error && (
          <p className="alert" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="notice" role="status">
            {message}
          </p>
        )}
        <label className="field">
          Inspection age in days
          <input
            type="number"
            min={7}
            max={365}
            value={days}
            onChange={(e) => {
              setDays(Number(e.target.value));
              setPreview(undefined);
            }}
          />
        </label>
        <label className="consent">
          <input
            type="checkbox"
            checked={automatic}
            onChange={(e) => setAutomatic(e.target.checked)}
          />
          Automatically remove eligible inspections
        </label>
        <p className="hint">
          Disabled by default. When enabled, cleanup runs every minute in
          batches of up to 100. External backups follow your operator’s separate
          retention policy.
        </p>
        <div className="control-actions">
          <button
            className="button secondary"
            disabled={busy || !policy}
            onClick={() =>
              void act(async () => {
                const saved = await request<RetentionPolicy>(
                  "/retention",
                  "PUT",
                  { days: automatic ? days : 0, version: policy!.version },
                );
                setPolicy(saved);
                setMessage("Retention policy saved.");
              })
            }
          >
            Save policy
          </button>
          <button
            className="button"
            disabled={busy || !policy}
            onClick={() =>
              void act(async () =>
                setPreview(
                  await request<RetentionPreview>(
                    "/retention/preview",
                    "POST",
                    { days },
                  ),
                ),
              )
            }
          >
            Preview cleanup
            <ArrowRight size={15} />
          </button>
        </div>
      </section>
      <section className="control-card">
        <p className="eyebrow">REVIEW BEFORE REMOVAL</p>
        <h2>Cleanup preview</h2>
        {preview ? (
          <>
            <div className="retention-count">
              {preview.count}
              <span>eligible inspections</span>
            </div>
            <p className="control-copy">
              {(preview.bytes / 1024 / 1024).toFixed(2)} MB of evidence ·{" "}
              {preview.held} reports on hold. This preview expires in 10 minutes
              and covers up to 100 inspections.
            </p>
            <ul className="cleanup-list">
              {preview.examples.map((r) => (
                <li key={r.id}>
                  <strong>{r.projectName}</strong>
                  <span>{new Date(r.createdAt).toLocaleDateString()}</span>
                </li>
              ))}
            </ul>
            <Dialog.Root
              open={open}
              onOpenChange={(v) => {
                if (!busy) {
                  setOpen(v);
                  setConfirm("");
                }
              }}
            >
              <Dialog.Trigger asChild>
                <button
                  className="button danger"
                  disabled={!preview.count || busy}
                >
                  Remove {preview.count} inspections
                </button>
              </Dialog.Trigger>
              <Dialog.Portal>
                <Dialog.Overlay className="dialog-overlay" />
                <Dialog.Content className="dialog-content">
                  <Dialog.Title>Remove saved evidence?</Dialog.Title>
                  <Dialog.Description>
                    This permanently removes {preview.count} finished
                    inspections and their screenshots from this workspace.
                    Reports on hold are excluded. Type DELETE to confirm.
                  </Dialog.Description>
                  <label className="field">
                    Confirmation
                    <input
                      autoComplete="off"
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                    />
                  </label>
                  {error && (
                    <p role="alert" className="alert">
                      {error}
                    </p>
                  )}
                  <div className="control-actions">
                    <Dialog.Close asChild>
                      <button className="button secondary" disabled={busy}>
                        Keep evidence
                      </button>
                    </Dialog.Close>
                    <button
                      className="button danger"
                      disabled={confirm !== "DELETE" || busy}
                      onClick={() =>
                        void act(async () => {
                          const result = await request<{
                            deleted: number;
                            pendingFiles: number;
                          }>("/retention/purge", "POST", {
                            token: preview.token,
                            confirm,
                          });
                          setOpen(false);
                          setPreview(undefined);
                          setMessage(
                            `${result.deleted} inspections removed.${result.pendingFiles ? " Evidence file cleanup will retry automatically." : " Evidence files deleted."}`,
                          );
                        })
                      }
                    >
                      {busy ? "Removing…" : "Delete permanently"}
                    </button>
                  </div>
                  <Dialog.Close asChild>
                    <button
                      className="dialog-close icon-button"
                      aria-label="Close cleanup confirmation"
                      disabled={busy}
                    >
                      <X size={18} />
                    </button>
                  </Dialog.Close>
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          </>
        ) : (
          <div className="retention-empty">
            <Archive size={32} />
            <p>Choose an age and preview the evidence eligible for removal.</p>
            <span>No inspections are removed by previewing.</span>
          </div>
        )}
      </section>
    </div>
  );
}

export function HoldControl({
  run,
  onChange,
}: {
  run: Run;
  onChange: () => Promise<unknown>;
}) {
  const [note, setNote] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <details className="hold-control">
      <summary>
        <Archive size={14} />
        {run.hold
          ? "Evidence protected by retention hold"
          : "Evidence retention"}
      </summary>
      {run.hold ? (
        <p>
          {run.hold.note}
          <span className="hint"> — {run.hold.actor}</span>
        </p>
      ) : (
        <label className="field">
          Reason to preserve this report
          <input
            value={note}
            minLength={10}
            maxLength={300}
            onChange={(e) => setNote(e.target.value)}
            placeholder="For example, evidence for the release review"
          />
        </label>
      )}
      {error && <p role="alert">{error}</p>}
      <button
        className="button secondary small"
        disabled={busy || (!run.hold && note.trim().length < 10)}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await request("/runs/" + run.id + "/hold", "PUT", {
              note: run.hold ? null : note.trim(),
            });
            await onChange();
            setNote("");
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {run.hold ? "Release hold" : "Protect evidence"}
      </button>
    </details>
  );
}
