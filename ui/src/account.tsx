import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  ArrowRight,
  Building2,
  Check,
  Copy,
  KeyRound,
  LoaderCircle,
  LogOut,
  ShieldCheck,
  Users,
} from "lucide-react";
import type { SessionInfo } from "../../src/contracts";
import type { Invitation } from "../../src/registration";
import { WorkspacePhoto } from "./onboarding";
import { request } from "./client";

export function AccountPortal({
  session,
  onSignOut,
}: {
  session: SessionInfo;
  onSignOut: () => void;
}) {
  const reduced = useReducedMotion();
  const [name, setName] = useState("");
  const [requestedOrigin, setRequestedOrigin] = useState("");
  const [requestId] = useState(() => crypto.randomUUID());
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ id: string; name: string }>();
  const [createMore, setCreateMore] = useState(
    window.location.pathname === "/signup",
  );
  function enter(id: string) {
    localStorage.setItem("inspector-organization", id);
    window.location.assign("/");
  }
  async function load() {
    try {
      setError("");
      setInvitations(
        (await request<{ invitations: Invitation[] }>("/account")).invitations,
      );
      setLoaded(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    if (session.mode === "hosted") void load();
  }, []);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const showCreate =
    session.signupEnabled &&
    loaded &&
    (createMore || (!session.organizations.length && !invitations.length));
  return (
    <main className="account-page">
      <header className="account-header">
        <a className="signin-brand" href="/">
          <img src="/mark.svg" alt="" />
          Launch Inspector
        </a>
        <span className="account-header-label">
          ACCOUNT & ORGANIZATION SETUP
        </span>
        {session.mode === "hosted" && (
          <button className="text-button" onClick={onSignOut}>
            <LogOut size={16} />
            Sign out
          </button>
        )}
      </header>
      {session.demo && (
        <p className="demo-notice">
          Demonstration environment · Synthetic identities and temporary
          workspaces. No real accounts are created.
        </p>
      )}
      <div className="account-layout">
        <aside className="account-story">
          <p className="eyebrow">A CLEAR PATH TO RELEASE</p>
          <h1>
            Good releases
            <br />
            start together.
          </h1>
          <p>
            Give your team a shared place to inspect, investigate and decide
            what ships.
          </p>
          <WorkspacePhoto />
          <ol className="account-steps" aria-label="Account setup progress">
            {[
              "Verify your identity",
              "Set up your organization",
              "Prepare your first inspection",
            ].map((label, index) => (
              <li
                key={label}
                aria-current={
                  (created ? index === 2 : index === 1) ? "step" : undefined
                }
              >
                <span>
                  {index === 0 || (created && index === 1) ? (
                    <Check size={16} />
                  ) : (
                    `0${index + 1}`
                  )}
                </span>
                <div>
                  <strong>{label}</strong>
                  <small>
                    {
                      [
                        "Your verified work account",
                        "A private workspace for your team",
                        "Approve a target, then collect evidence",
                      ][index]
                    }
                  </small>
                </div>
              </li>
            ))}
          </ol>
        </aside>
        <motion.section
          className="account-panel"
          initial={{ opacity: 0, y: reduced ? 0 : 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: reduced ? 0 : 0.22 }}
        >
          {error && (
            <div role="alert" className="alert">
              {error}
              {!loaded && (
                <button className="text-button" onClick={() => void load()}>
                  Try again
                </button>
              )}
            </div>
          )}
          {notice && (
            <p role="status" className="account-notice">
              {notice}
            </p>
          )}
          {session.mode === "local" ? (
            <>
              <p className="eyebrow">LOCAL WORKSPACE</p>
              <h2>Hosted accounts, when you need them.</h2>
              <p>
                This private instance uses local owner access. Sign-up,
                organization invitations and work-account login are available
                when the service is deployed in hosted mode.
              </p>
              <a className="button" href="/">
                Return to your workspace
                <ArrowRight size={17} />
              </a>
            </>
          ) : created ? (
            <>
              <span className="account-success">
                <Check size={28} />
              </span>
              <p className="eyebrow">ORGANIZATION CREATED</p>
              <h2>{created.name} is ready.</h2>
              <p>
                You are the organization owner. Invite your teammates and
                prepare your first inspection in the workspace.
              </p>
              <div className="account-next">
                <ShieldCheck size={24} />
                <div>
                  <h3>Next: approve your staging target</h3>
                  <p>
                    {requestedOrigin
                      ? `${requestedOrigin} was recorded for operator review.`
                      : "Ask your service operator to approve a staging origin for this organization."}{" "}
                    Then prove control of that domain in Organization controls →
                    Verified targets before running checks.
                  </p>
                </div>
              </div>
              <label className="account-reference">
                Organization reference
                <input value={created.id} readOnly />
              </label>
              <button
                className="text-button"
                onClick={() =>
                  void act(async () => {
                    await navigator.clipboard.writeText(created.id);
                    setNotice("Organization reference copied.");
                  })
                }
              >
                <Copy size={16} />
                Copy reference for your operator
              </button>
              <button
                className="button account-primary"
                onClick={() => enter(created.id)}
              >
                Open organization workspace
                <ArrowRight size={18} />
              </button>
            </>
          ) : (
            <>
              <p className="eyebrow">YOUR VERIFIED ACCOUNT</p>
              <div className="account-identity">
                <span>
                  <KeyRound size={22} />
                </span>
                <div>
                  <strong>{session.user?.name}</strong>
                  <small>{session.user?.email}</small>
                </div>
                <ShieldCheck size={20} aria-label="Email verified" />
              </div>
              {!loaded && !error && (
                <p role="status">
                  <LoaderCircle className="spin" size={18} />
                  Loading your organizations…
                </p>
              )}
              {!!invitations.length && (
                <section className="account-section">
                  <h2>Join your team.</h2>
                  <p>
                    Your organization owner has invited this verified email
                    address.
                  </p>
                  <div className="account-list">
                    {invitations.map((i) => (
                      <article className="account-invitation" key={i.id}>
                        <div>
                          <strong>{i.organizationName}</strong>
                          <span>
                            {i.role} ·{" "}
                            {i.projectIds.length
                              ? `${i.projectIds.length} selected projects`
                              : "All projects"}
                          </span>
                          <small>
                            Expires {new Date(i.expiresAt).toLocaleDateString()}
                          </small>
                        </div>
                        <button
                          className="button secondary"
                          disabled={busy}
                          onClick={() =>
                            void act(async () => {
                              const org = await request<{ id: string }>(
                                "/account/accept-invitation",
                                "POST",
                                { id: i.id },
                              );
                              enter(org.id);
                            })
                          }
                        >
                          Accept invitation
                          <ArrowRight size={16} />
                        </button>
                      </article>
                    ))}
                  </div>
                </section>
              )}
              {!!session.organizations.length && !showCreate && (
                <section className="account-section">
                  <h2>Your organizations.</h2>
                  <div className="account-list">
                    {session.organizations.map((o) => (
                      <button
                        className="account-workspace"
                        key={o.organizationId}
                        onClick={() => enter(o.organizationId)}
                      >
                        <Building2 size={22} />
                        <span>
                          <strong>{o.name}</strong>
                          <small>{o.role} access</small>
                        </span>
                        <ArrowRight size={17} />
                      </button>
                    ))}
                  </div>
                </section>
              )}
              {showCreate && (
                <section className="account-section">
                  <h2>Make room for your team.</h2>
                  <p>
                    Create your organization’s workspace. You will become its
                    first owner.
                  </p>
                  <form
                    className="organization-registration-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act(async () => {
                        setCreated(
                          await request("/organizations", "POST", {
                            name,
                            requestedOrigin: requestedOrigin.trim(),
                            requestId,
                          }),
                        );
                      });
                    }}
                  >
                    <label>
                      Organization name
                      <input
                        required
                        minLength={2}
                        maxLength={100}
                        autoComplete="organization"
                        placeholder="e.g. Acme Engineering"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                      />
                    </label>
                    <label>
                      Staging origin{" "}
                      <span className="field-optional">Optional</span>
                      <input
                        type="url"
                        maxLength={2048}
                        placeholder="https://staging.example.com"
                        value={requestedOrigin}
                        aria-describedby="staging-hint"
                        onChange={(e) => setRequestedOrigin(e.target.value)}
                      />
                    </label>
                    <p className="field-hint" id="staging-hint">
                      Use the exact HTTPS origin, without a trailing slash. Your
                      service operator approves it before you verify ownership
                      and run inspections.
                    </p>
                    <div className="account-permissions">
                      <Users size={20} />
                      <p>
                        You control who joins. Teammates get owner, editor or
                        viewer access through individual invitations.
                      </p>
                    </div>
                    <button className="button" disabled={busy}>
                      {busy ? (
                        <LoaderCircle className="spin" size={18} />
                      ) : (
                        <Building2 size={18} />
                      )}
                      Create organization
                      <ArrowRight size={18} />
                    </button>
                    {(invitations.length > 0 ||
                      session.organizations.length > 0) && (
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setCreateMore(false)}
                      >
                        Back to your organizations
                      </button>
                    )}
                  </form>
                </section>
              )}
              {loaded && !showCreate && session.signupEnabled && (
                <button
                  className="text-button account-create-link"
                  onClick={() => setCreateMore(true)}
                >
                  <Building2 size={16} />
                  Create a new organization
                </button>
              )}
              {loaded &&
                !session.signupEnabled &&
                !invitations.length &&
                !session.organizations.length && (
                  <section className="account-section">
                    <h2>You’re signed in.</h2>
                    <p>
                      No organization membership is available for this account.
                      Ask an owner to invite{" "}
                      <strong>{session.user?.email}</strong>, then refresh your
                      invitations.
                    </p>
                    <button
                      className="button secondary"
                      onClick={() => void load()}
                    >
                      Refresh invitations
                    </button>
                  </section>
                )}
              <div className="account-security">
                <ShieldCheck size={19} />
                <div>
                  <strong>Identity managed by your sign-in provider</strong>
                  <p>
                    Manage your password, email, recovery and MFA with that
                    provider. You can end your other Launch Inspector sessions
                    here.
                  </p>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        const result = await request<{ revoked: number }>(
                          "/account/revoke-sessions",
                          "POST",
                          {},
                        );
                        setNotice(
                          `${result.revoked} other session${result.revoked === 1 ? "" : "s"} signed out. This session remains active.`,
                        );
                      })
                    }
                  >
                    Sign out other sessions
                  </button>
                </div>
              </div>
            </>
          )}
        </motion.section>
      </div>
    </main>
  );
}
