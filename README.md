# Launch Inspector

**Check login, account permissions and customer journeys before releasing a web app.**

Launch Inspector runs a real Chromium browser against a test deployment, records what happened, and produces findings with screenshots and reproduction steps. It gives developers and agencies a repeatable way to check applications assembled quickly with AI tools or conventional development workflows.

Version **0.1.0** is a working local pilot. The runner, configuration dashboard, sample applications and report exports are implemented. Checks are explicit browser assertions; this release does not use an AI model, read your source code or automatically fix findings.

![Launch Inspector reviewing an intentionally faulty sample application](docs/workbench.png)

_The screenshot shows synthetic demonstration data. Its four findings were produced by actual browser runs._

## What you can inspect

| Check               | Example use case                                                                                  | Evidence collected                                                |
| ------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Page content        | Confirm that the pricing or onboarding page actually renders                                      | HTTP result, visible content and screenshot                       |
| Login               | Confirm valid credentials reach the expected account page; optionally check one invalid password  | Signed-in URL, success or rejection text, screenshots             |
| Account permissions | Verify that an anonymous visitor, regular member or second customer cannot view protected content | An authorized baseline followed by an isolated restricted session |
| Customer journey    | Sign in, change a profile field, save, reload and verify the change persisted                     | Recorded navigation, form actions and visible-text assertions     |

The workbench supports multiple saved targets, configurable test accounts, run history, cancellation, screenshot review, and downloadable Markdown or JSON reports. You can associate a GitHub repository URL with a target as a reference.

## Start locally

Requirements: **Node.js 22.12 or newer**, npm, and a supported Windows, macOS or Linux environment for [Playwright Chromium](https://playwright.dev/docs/browsers). CI uses Node.js 24. Browser installation needs internet access and disk space.

```sh
git clone https://github.com/Billioncodes001/app-launch-inspector.git
cd app-launch-inspector
npm ci
npx playwright install chromium
npm run build
npm start
```

On Linux, use `npx playwright install --with-deps chromium` to install required system libraries as well. Installing system packages can require administrator privileges.

Open **[http://127.0.0.1:8795](http://127.0.0.1:8795)**. The same process starts the controlled sample application on port **8796**. Run commands from the repository root. Stop with Ctrl+C.

The application binds to loopback. It is intended for a developer's workstation or a dedicated test machine with a local browser. This release has no multi-user sign-in or supported public dashboard deployment.

### Try the included demonstration

1. Select **Run faulty sample** in the workbench.
2. Review the six checks. Two should pass and four should fail: anonymous admin access, member admin access, cross-account document access, and a profile change that does not persist.
3. Open a finding to compare the authorized and restricted screenshots and read its reproduction steps.
4. Select **Run corrected sample**. All six checks should pass.
5. Download a Markdown report to share or JSON for a downstream workflow.

These are two deliberately controlled applications with real HTTP sessions and forms. They demonstrate detection and regression checking; they are not customer production results. All sample accounts and content are synthetic. The sample password in the source is deliberately public and must never be reused for real accounts.

## Configure your own application

Use a local or staging deployment you control and dedicated test accounts whose data may be changed by your configured journeys.

1. Choose **New target** and enter its origin, such as `http://127.0.0.1:3000` or `https://staging.example.com`. Enter paths separately. A repository URL is optional.
2. Configure the login path, exact accessible field labels, sign-in button name, successful sign-in path and visible success text. For invalid-password checks, also enter the rejection message.
3. Add the accounts your scenarios need, such as an administrator, a member, and a second member. Use stable IDs to reference them in checks.
4. Add page, login, permission or journey checks. Paths must stay on the configured origin. Every journey must include at least one visible-text assertion.
5. Save the target, acknowledge that you are authorized to exercise it, and run the inspection.

For permission checks, **the authorized baseline must first see the protected marker**. The runner then creates a separate browser context for the restricted account or an anonymous visitor. A missing page or failed owner login cannot produce a passing permission check. The restricted session must receive an explicit denial, denied HTTP status or login redirect, with the protected marker absent.

Use a specific protected marker, such as a unique document title, rather than a generic navigation label. The runner observes rendered content; it does not inspect every response body for data that the UI hides.

An optional invalid-password check makes one failed sign-in attempt. Use disposable accounts if your application has account lockout rules. Journeys can submit forms and change application state; the runner does not roll those changes back.

Saved passwords are not returned to the browser. When editing an existing account, leave its password blank to retain the saved value. A new account requires a password. Rename display names freely; changing an account ID creates a different credential reference.

## Interpret results

| Status                      | Meaning                                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Passed                      | The configured assertion succeeded within the supported environment.                                                                            |
| Failed                      | The observed behavior contradicted the configured check. Review its evidence and configuration.                                                 |
| Inconclusive                | A baseline, dependency, login contract, browser operation or other required observation could not be completed reliably. Investigate and rerun. |
| Cancelled / interrupted run | Only the completed results are available. Remaining checks have not passed.                                                                     |

A completed run means execution finished, not that all checks passed. The dashboard reports findings and incomplete checks separately. There is no universal security score or launch certification.

Each report records the target, configuration revision, run ID, expected behavior, observations, reproduction steps and recommendations. Screenshot files stay in the local run directory and can be viewed in the dashboard; Markdown and JSON exports reference results rather than embedding image bytes. Reports do not include the saved account configuration. Textual results redact known passwords and configured form-fill values.

Interrupted runs are marked as interrupted when the service starts again. They are **never automatically replayed**, because replaying a journey could repeat a state-changing form submission.

## Supported boundaries

This release supports same-origin HTTP applications on loopback and same-origin HTTPS applications on public addresses. It uses labeled forms, buttons, links and visible text. The target must be reachable from the runner and have a valid TLS certificate when using HTTPS.

The runner blocks other origins, WebSockets and service workers. Private LAN, link-local and metadata destinations are rejected; the dashboard's own port cannot be a target. DNS destinations are validated before execution and the selected address is pinned in Chromium. Blocking a dependency can make a check inconclusive.

Consequently, these scenarios are currently outside the supported scope:

- Cross-origin SSO, OAuth providers, MFA and CAPTCHA.
- Applications dependent on third-party assets, APIs or embedded payment providers.
- WebSocket-driven workflows and service-worker-dependent behavior.
- Private LAN staging hosts, certificate bypasses, native apps and mobile devices.
- General vulnerability scanning, exhaustive API authorization analysis, load testing or source-code remediation.

Configure a same-origin test environment for supported checks. This runner is not a hardened sandbox for arbitrary hostile websites; use an isolated test machine when the inspected application is untrusted.

## Local data and privacy

By default, application state is stored in `~/.app-launch-inspector`, outside the repository:

| File                     | Contents                                                                     |
| ------------------------ | ---------------------------------------------------------------------------- |
| `master.key`             | Local encryption key. Keep private.                                          |
| `projects.enc`           | AES-256-GCM encrypted project settings, test credentials and journey inputs. |
| `runs/<run-id>/run.json` | Run metadata, observations and result records.                               |
| `runs/<run-id>/*.png`    | Captured browser evidence.                                                   |

Back up the key and encrypted configuration together if you need recovery. Encryption does not protect against someone who can read both files. File modes are restrictive on platforms that enforce POSIX permissions; use account-level filesystem permissions on Windows.

Reports and screenshots are **not encrypted**. Screenshots mask inputs, textareas, elements marked `data-private` or `data-sensitive`, and exact known-password text. Other visible application data can still appear. Review evidence before sharing it. There is no automatic retention deletion in this release; the dashboard lists the latest 100 runs, while older files remain on disk.

The inspector does not send reports or credentials to an AI service or analytics endpoint. Browser checks necessarily send requests and configured test credentials to the target application.

Dashboard API requests require a per-process token injected into the local page. Host, origin and fetch-metadata checks restrict access from unrelated web pages. Keep the service on loopback; do not expose it through a public reverse proxy.

## Configuration and limits

| Setting               | Default                   |
| --------------------- | ------------------------- |
| `INSPECTOR_PORT`      | `8795`                    |
| `INSPECTOR_DEMO_PORT` | `8796`                    |
| `INSPECTOR_DATA_DIR`  | `~/.app-launch-inspector` |

Ports must be different integers between 1024 and 65535. The CLI does not automatically load `.env`. Set environment variables in your shell, or copy [`.env.example`](.env.example) to `.env` and run:

```sh
node --env-file=.env dist/cli.js
```

The runner allows one active inspection, up to five active-plus-queued runs, six accounts, twelve checks per target and twelve steps per journey. The default run budget is 180 seconds, navigation timeout is 15 seconds, and locator wait is 6 seconds. Each browser context has a 250-request limit. Each actor/check uses a fresh browser context without importing your personal browser profile.

## Development and validation

```sh
npm run check
```

This builds TypeScript and the React interface, runs the backend/browser integration suite, then runs the dashboard browser suite. Tests start their own sample servers and use temporary data directories. Port 8797 must be free for UI tests.

- Backend coverage: configuration validation, destination restrictions, encryption and tamper rejection, token/origin enforcement, request limits, real permission failures, corrected behavior, blocked dependencies, cancellation and restart recovery.
- Dashboard coverage: custom targets, consent before runs, account editing with password retention, journey editing, evidence dialogs, exports, refresh persistence, keyboard operation, automated accessibility checks and mobile layouts.
- Visual review covers 1440, 1024, 768, 390 and 320 pixel viewport widths. Browser screenshots are written to ignored `artifacts/` and failure details to `test-results/`.

The [CI workflow](.github/workflows/ci.yml) runs the same checks on Windows and Ubuntu. These controlled tests establish behavior for the supported scenarios; broader customer pilot validation remains to be done.

For backend development, first build the UI, stop any existing instance on the configured ports, then use `npm run dev`. It watches the server TypeScript with `tsx`. UI changes require `npm run build` and a server restart because the control server serves a tokenized, cached build of the HTML. There is no UI hot-reload server in this release.

### Source map

```text
src/contracts.ts     Validated target, account, check and result models
src/network.ts       Destination and origin policies
src/store.ts         Encrypted configuration and atomic run storage
src/runner.ts        Browser execution, evidence and report generation
src/demo.ts          Faulty/corrected controlled applications
src/server.ts        Local dashboard server and token-protected API
src/cli.ts           Startup, settings and shutdown
ui/                  React, Tailwind CSS, Motion and Lucide workbench
test/                Backend and real-browser integration tests
```

The interface uses IBM Plex Sans and Mono. Their bundled licenses are included in [the UI assets](ui/public/). Playwright controls the browser; no existing browsing profile is loaded.

## Product direction

The initial audience is developers and agencies validating a staging release. Next priorities are customer pilot feedback, reusable check templates and richer evidence. Repository analysis, AI-assisted explanations, reviewed fix proposals, team access and CI gating are future work, not current capabilities. The optional repository field does not grant GitHub access or create pull requests.

Bug reports should include the inspector version, operating system, check type and a minimal reproduction. Replace private URLs, credentials and application content with synthetic examples before attaching reports.
