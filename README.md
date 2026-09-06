# Launch Inspector

**Browser evidence for release decisions — with separate workspaces for every customer.**

Launch Inspector checks login, account permissions and customer journeys against a running web application. It uses real Chromium sessions, records screenshots and reproduction steps, and gives teams a shared place to review the findings before release.

Version **0.2.0** adds a hosted service mode for multiple companies: OpenID Connect sign-in, organization and project permissions, review decisions, audit history, transactional storage and tested recovery tools. Local mode remains available for individual developers. This is a working hosted pilot; production readiness still depends on your infrastructure, identity provider, operating procedures and independent security review.

![Launch Inspector inspecting a deliberately faulty sample application](docs/workbench.png)

_Synthetic application data. The four findings shown came from actual browser checks._

## Who it helps

| Team                              | Practical use case                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Software agencies                 | Keep each customer's staging targets, credentials, reports and reviewers in a separate organization.                        |
| SaaS engineering                  | Check that one customer cannot see another customer's protected page, then repeat the same checks after a fix.              |
| Release and QA teams              | Exercise sign-in and a saved customer journey, review evidence, and record why a finding remains open or has accepted risk. |
| Developers building with AI tools | Verify that generated login and permission flows actually behave as expected in a browser.                                  |

Checks are explicit assertions. The current release does not use an AI model, analyze source code, create pull requests or automatically repair an application. The optional repository field is a reference link.

## Capabilities

| Check               | Example                                                                                   | Evidence                                                        |
| ------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Page                | Pricing or onboarding content renders                                                     | HTTP observation, visible text and screenshot                   |
| Login               | Valid credentials reach the expected account page; optionally reject one invalid password | Signed-in path, success or rejection text and screenshots       |
| Account permissions | An anonymous visitor, member or second customer cannot see a protected marker             | Authorized baseline, followed by an isolated restricted session |
| Journey             | Edit a profile, save, reload and verify persistence                                       | Navigation, form actions and visible-text assertions            |

The dashboard supports saved targets, test accounts, run history, cancellation, evidence dialogs, Markdown/JSON exports and review notes. Review decisions keep the original observed result unchanged: accepting a risk never converts a failed check into a pass.

### Organization controls

- **Sign-in:** standard OpenID Connect authorization code flow with PKCE, signed-token verification, verified email, secure server sessions and optional required authentication context. Your identity provider enforces MFA.
- **Customer isolation:** every project, run, screenshot, review and audit request is scoped to the signed-in user's organization and project permissions.
- **Roles:** owners manage membership and accept risk; editors configure and run assigned targets; viewers review assigned evidence. A member can belong to more than one organization with different roles.
- **Change control:** configuration, membership and finding reviews use revision checks to reject stale updates.
- **Traceability:** per-organization audit records include sign-ins, access changes, configuration saves, run events, exports and review decisions, with keyed integrity verification.
- **Operations:** SQLite WAL transactions, scoped AES-256-GCM configuration encryption, bounded browser capacity, health checks, service exclusivity, backup verification and restore with session revocation.

![Organization audit history and review decisions](docs/organizations.png)

_The organization names, identities and review notes are synthetic demonstration data._

## Run locally

Requirements: **Node.js 24.13+**, npm and a [Playwright-supported operating system](https://playwright.dev/docs/browsers). Windows and Ubuntu are tested in CI. Browser installation requires internet access and disk space.

```sh
git clone https://github.com/Billioncodes001/app-launch-inspector.git
cd app-launch-inspector
npm ci
npx playwright install chromium
npm run build
node dist/cli.js doctor
npm start
```

On Linux use `npx playwright install --with-deps chromium` to install the system libraries as well.

Open **[127.0.0.1:8795](http://127.0.0.1:8795)**. Local mode binds only to loopback and starts a controlled sample application on port **8796**. Choose **Run faulty sample** to see four seeded failures, then inspect the corrected sample to see all six checks pass. These are executed browser scenarios, not prewritten reports.

### Try the multi-company demo

After the installation and build above, run:

```sh
npm run demo:organizations
```

Open **[127.0.0.1:8798](http://127.0.0.1:8798)** and choose **Sign in with your work account**. The local test identity provider lets you choose a synthetic identity without entering a password:

| Demo identity           | Access                                            |
| ----------------------- | ------------------------------------------------- |
| `owner-a@example.test`  | Owner of Northstar Labs; viewer in Harbor Systems |
| `owner-b@example.test`  | Owner of Harbor Systems                           |
| `viewer-a@example.test` | Viewer of Northstar's assigned staging project    |

Try an inspection, record a review, open **Organization controls**, change a synthetic member's project access, inspect the audit history and switch organizations. Demo data is temporary. This test provider intentionally allows HTTP and local targets; it is excluded from the production image and must never be used as a hosted identity provider.

## Host for multiple companies

The repository includes a Docker image, Compose deployment and Caddy TLS reverse proxy. Hosted mode requires a domain, your OpenID Connect developer application and an operator-approved target origin for each company. There is no public self-registration.

Follow **[Hosting and customer onboarding](docs/HOSTING.md)** for the complete setup, environment variables and role model. Follow **[Operations and recovery](docs/OPERATIONS.md)** for health checks, backups, restore, upgrade and capacity planning. Read **[Security boundaries](docs/SECURITY.md)** before a customer pilot.

The supported topology is **one service instance on one host with persistent local storage**, serving multiple logically isolated organizations. It is not a horizontally scalable or highly available deployment. Use a dedicated host and network egress controls for customer browser workloads.

## Configure an inspection

1. Select **New target**. Enter an origin such as `https://staging.example.com`; hosted targets must already be approved for the organization.
2. Configure the login path, exact accessible field labels, button name, successful path and visible success text. Provide the rejection message if testing an invalid password.
3. Add disposable test accounts with stable IDs, such as `owner`, `member` and `customer-two`.
4. Add page, login, permission or journey checks. Every journey needs at least one visible-text assertion.
5. Save the target, acknowledge authorization to exercise it, and run the inspection.

The authorized account must first see the protected marker before a permission check tests a restricted account. A failed baseline cannot produce a passing permission result. Choose a specific marker, such as a protected document title, rather than a generic navigation label. This checks rendered content; it does not examine every response body for hidden data.

Passwords are not returned to the browser. Leave an existing account's password blank to retain it; new accounts require one. Journeys can submit forms and change target state; those changes are not rolled back. An optional invalid-password check makes one failed sign-in attempt.

## Understand the evidence

| Result                  | Meaning                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| Passed                  | The configured assertion succeeded in this execution environment.                            |
| Failed                  | Observed behavior contradicted the assertion. Review the evidence and configuration.         |
| Inconclusive            | A baseline, dependency, login contract or browser operation could not be completed reliably. |
| Cancelled / interrupted | Unfinished checks have no passing result. Completed observations remain available.           |

A completed run means execution finished. It does not mean all checks passed. Reports record the configuration revision, run ID, expected behavior, observations and reproduction steps. Screenshots remain separate files; Markdown and JSON exports do not embed their bytes. Known passwords and configured fill values are redacted from textual results.

Failed findings can be **open**, **investigating** or **accepted risk**, with a required review note. Only an owner can accept risk. Reviews and their authors appear in reports and audit history. Interrupted runs are never automatically replayed because a journey may have submitted a form already.

## Supported application boundaries

The runner supports same-origin applications on public HTTPS origins; local mode also allows loopback HTTP. It validates and pins DNS destinations, blocks other origins, WebSockets and service workers, and rejects private, link-local and metadata addresses. Hosted mode additionally checks an operator-controlled origin list for each company.

Target applications that require cross-origin SSO, MFA, CAPTCHA, third-party APIs/assets, embedded payment providers or WebSocket/service-worker behavior are outside the current scope. A blocked dependency can make a result inconclusive. **Dashboard OIDC sign-in is supported; automating OIDC sign-in inside an inspected application is not.**

This is not an exhaustive vulnerability scanner, load-testing service or launch certification. Use authorized staging environments and disposable data.

## Storage and privacy

By default, data lives in `~/.app-launch-inspector`, outside this repository:

| Location                                | Contents                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `master.key`                            | Root encryption and audit key; essential for recovery                                                 |
| `inspector.sqlite` and WAL files        | Encrypted project settings, organization membership, sessions, run records, reviews and audit history |
| `runs/<organization-id>/<run-id>/*.png` | Browser screenshots                                                                                   |

Version 0.1 data is imported transactionally into the local workspace on first startup. Legacy files are preserved. Back up the complete data directory before upgrading; use the new backup CLI for subsequent snapshots.

Configuration is encrypted with organization/project-scoped keys. **Reports, screenshots and identity metadata are not encrypted by the application.** Use encrypted storage and backups, restrictive filesystem access and synthetic accounts. Screenshots mask input fields and marked private elements, but other visible customer data can still appear. There is no automatic retention deletion yet; the UI lists the latest 100 runs while older records remain stored.

No report or credential is sent to an AI or analytics service. Checks necessarily send credentials and configured actions to the inspected application. Hosted sign-in communicates with your identity provider. See the security and operations guides for the full boundaries.

## Development and verification

```sh
npm run check
```

This builds the server and React UI, runs 15 backend/integration tests, then 9 dashboard browser tests. Ports **8797** and **8798** must be free. Stop the organization demo first. All fixtures use temporary data and synthetic accounts.

- Actual browser runs demonstrate four seeded failures and six passing checks after correction.
- Hosted tests exercise signed OIDC responses, callback replay, invalid signatures and claims, session expiry, membership revocation and cross-company/project access attempts.
- Operations tests restore configuration and evidence, revoke restored sessions, reject damaged backups and prevent competing service instances.
- UI tests exercise sign-in, organization switching, roles, member changes, finding review, exports, keyboard interactions, mobile layouts and automated accessibility checks.
- [CI](.github/workflows/ci.yml) runs on Windows and Ubuntu and additionally executes real browser inspections in a non-root Docker container with Chromium's sandbox enabled.

Screenshots and traces are written to ignored `artifacts/` and `test-results/` directories. Controlled tests establish behavior for these scenarios; customer infrastructure and identity-provider pilots remain necessary.

For backend development, build once, stop the existing server and run `npm run dev`. UI changes need a new build and server restart. The interface uses React 19, TypeScript, Tailwind CSS 4, Motion, Lucide and locally bundled IBM Plex fonts.

| Source                              | Responsibility                                                         |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `src/runner.ts`, `src/network.ts`   | Browser checks, target restrictions, screenshots and report generation |
| `src/access.ts`, `src/auth.ts`      | Organization permissions and OpenID Connect sessions                   |
| `src/database.ts`, `src/store.ts`   | Transactions, scoped encryption, records and audit integrity           |
| `src/operations.ts`, `src/cli.ts`   | Single-instance lease, backup, restore and operator commands           |
| `src/server.ts`, `src/contracts.ts` | Validated HTTP API and shared models                                   |
| `ui/src/`                           | Workbench, configuration, organization administration and review       |
| `test/`                             | Integration tests, browser tests and synthetic identity provider       |

The next commercial milestones are external customer pilots, infrastructure isolation review, retention automation, service observability, enterprise identity lifecycle integrations and a durable worker architecture for larger deployments. Billing, SCIM, per-company identity-provider configuration, automatic scheduling and high availability are not implemented in this release.
