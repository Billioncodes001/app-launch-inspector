# Hosting and customer onboarding

Launch Inspector 0.4 runs as one controller and one separate authenticated browser worker with separate customer organizations. This guide targets a dedicated Linux host and Docker Compose v2. Windows supports local development. Review [security boundaries](SECURITY.md) and [operations](OPERATIONS.md) before onboarding customer data.

## 1. Prepare infrastructure

Provide a domain whose DNS points to the host, inbound TCP 80/443 for Caddy, persistent local storage and a reachable HTTPS identity provider. The Compose application container has no published control port. Start with at least 4 GB host memory; the browser service is limited to 2 GB, two concurrent browsers and 20 total reserved runs. Load-test your actual pages before setting service commitments.

Use a dedicated host or equivalent isolation. Apply network controls that prevent browser workloads reaching private networks, host services and cloud metadata. Application destination filtering is an additional control, not a substitute for network isolation. Do not mount the Docker socket, host credentials or unrelated customer files into the service.

Chromium runs as UID/GID 1000 with its sandbox enabled, a read-only root filesystem, dropped Linux capabilities and the included Playwright seccomp profile. The host must support unprivileged user namespaces. If startup reports a sandbox error, fix the host policy; do not disable the sandbox or run a privileged container to make it pass. See [Playwright's container guidance](https://playwright.dev/docs/docker).

## 2. Register the identity application

Create a **confidential OpenID Connect web application** in your identity provider:

| Setting               | Value                                                                        |
| --------------------- | ---------------------------------------------------------------------------- |
| Redirect URI          | `https://inspector.example.com/auth/callback` (your exact domain)            |
| Flow                  | Authorization code with PKCE S256                                            |
| Scopes                | `openid email profile`                                                       |
| Client authentication | `client_secret_post` supported by the configured client                      |
| Claims                | Stable `sub`, `email` and boolean `email_verified: true`; `name` is optional |
| Token validation      | Signed ID tokens with discoverable JWKS; issuer and audience must match      |

Enforce MFA, sign-in risk policy and account recovery in the provider. If it emits an authentication context for your required policy, set `INSPECTOR_OIDC_REQUIRED_ACR` to that exact value. The service requests it and rejects a different returned `acr`. This setting does not enable MFA by itself.

The service uses one configured issuer; it can serve companies through a provider that brokers their identities. Separate per-company OIDC configurations, SCIM and back-channel logout are not implemented. Provider changes do not immediately revoke an existing inspector session: remove its membership in the inspector when immediate access revocation is required. Sign-out ends the inspector session, not the provider's own session.

## 3. Set deployment values

Clone the repository, copy `.env.example` to `.env` and set these uncommented values:

```dotenv
INSPECTOR_DOMAIN=inspector.example.com
INSPECTOR_OIDC_ISSUER=https://identity.example.com/your-issuer
INSPECTOR_OIDC_CLIENT_ID=your-client-id
# Optional: permit verified users to create organizations (default: invite_only)
INSPECTOR_SIGNUP=self_service
# Optional: provider-specific required authentication context
# INSPECTOR_OIDC_REQUIRED_ACR=your-mfa-context
```

Create `secrets/oidc_client_secret.txt` containing only the client secret. Also create `secrets/worker_token.txt` containing a cryptographically random shared token of at least 32 characters. For example, generate 32 random bytes with Node `crypto.randomBytes(32).toString("hex")` and write them directly to the private file. Never publish either secret. Protect the parent directory and `.env` with owner-only host permissions. Compose mounts that file as a secret; ensure UID 1000 can read it in the container. Both the controller and worker receive the worker token; only the controller receives the OIDC secret and persistent data volume. Neither `.env` nor `secrets/` is tracked by Git or included in the Docker build context.

```sh
docker compose config --quiet
docker compose build
```

Compose forces hosted mode, constructs the HTTPS public origin from `INSPECTOR_DOMAIN` and reads the secret through `INSPECTOR_OIDC_CLIENT_SECRET_FILE`. It uses a persistent named volume at `/data` and automatic TLS through Caddy. Pin reviewed container image digests in your release process and rebuild for browser/runtime security updates.

## 4. Onboard companies

### Self-service signup

With `INSPECTOR_SIGNUP=self_service`, start the stack with `docker compose up -d`. Customers open `/signup` and authenticate through your configured provider. Enable the provider's own account-registration and verified-email flow if customers do not already have identities there; Launch Inspector never stores dashboard passwords. A successful signed, verified identity becomes an application account, even before it belongs to an organization. Existing preapproved memberships are still claimed on first verified sign-in.

The account portal lets users accept an invitation or create an organization. Creation assigns only that new workspace's owner role, in a transaction. It never joins an existing company by domain or organization name. A replayed creation request returns the same organization. Each account may create three workspaces; the deployment caps organizations at 1,000 and accounts at 10,000. These limits bound this pilot, not a throughput commitment. Configure edge abuse controls and validate volume before opening registration broadly.

New workspaces have no approved targets. An optional staging origin is recorded for operator review; no email or operator notification is sent. Operators list requests and approve an exact origin during maintenance:

```sh
docker compose stop inspector
docker compose run --rm --no-deps inspector node dist/cli.js org-list
docker compose run --rm --no-deps inspector node dist/cli.js org-approve-target \
  --organization "CUSTOMER_ORGANIZATION_UUID" \
  --target "https://staging.example.com"
docker compose up -d inspector
```

Approval adds the origin to the existing allowlist. It does not prove domain control or run a check. The owner then opens **Organization controls → Verified targets**, publishes a DNS TXT record or HTTPS verification file, and verifies it before creating/running the first inspection. The signup completion screen and empty targets panel show the organization reference for the operator.

### Operator-provisioned companies (invitation-only default)

Before starting the service, approve the company owner and the exact HTTPS origins they may inspect:

```sh
docker compose run --rm --no-deps inspector node dist/cli.js org-create \
  --name "Example Company" \
  --owner "owner@example.com" \
  --target "https://staging.example.com"
docker compose run --rm --no-deps inspector node dist/cli.js org-list
docker compose up -d
docker compose ps
```

Replace all example values. Repeat `--target` for additional approved origins, up to 50. Target DNS must resolve to public addresses and use valid HTTPS. The service operator is responsible for confirming that the company is authorized to inspect these origins; after provisioning, the owner must prove control in **Organization controls → Verified targets** using a company-specific DNS TXT record or HTTPS verification file. New challenges expire in 24 hours. Successful verification lasts 30 days; renew it using the same published record. Expired targets cannot start new inspections.

The owner signs in with the exact approved, verified email. The first successful sign-in binds that membership to the issuer and subject; merely presenting the same email later from a different subject does not take it over. No invitation email is sent by Launch Inspector. An organization owner invites teammates through **Organization controls → People & access**. Select a role and optional project scope, create the invitation, then copy and share the `/join` link. The app does not send email. Invited users authenticate with the exact verified email and explicitly accept. Invitations expire after seven days and may be revoked; acceptance rechecks the inviter's current owner access and never overwrites an existing membership. A new invitation is needed if its creator loses owner access. Members and pending invitations together are limited to 100 per organization. Existing operator/API preapproved membership behavior remains supported for managed provisioning.

To provision another company, schedule a brief maintenance window, stop the inspector, run `org-create` again, then start it. The data-directory lease prevents provisioning while a service is active. Use `org-approve-target` to add a reviewed origin to an existing organization. Customers cannot approve their own targets.

## 5. Configure project access

| Action                                             | Owner | Editor                       | Viewer |
| -------------------------------------------------- | ----- | ---------------------------- | ------ |
| View assigned projects, evidence and reports       | Yes   | Yes                          | Yes    |
| Configure, run or cancel assigned checks           | Yes   | Yes                          | No     |
| Create a new project                               | Yes   | Only with all-project access | No     |
| Mark a finding open / investigating                | Yes   | Yes                          | No     |
| Accept a finding's risk                            | Yes   | No                           | No     |
| Manage members and view organization audit history | Yes   | No                           | No     |

An unrestricted membership includes current and future projects. A restricted membership includes only selected projects. Owners always have all-project access. The last activated owner cannot be removed; owners cannot remove or downgrade their own active membership. Add and activate another owner before transferring control.

Membership and project permissions are checked on every API request. Removal blocks subsequent access immediately and queued inspections recheck authorization before execution. An already executing inspection can finish; cancel it before removing a member if you also need to stop its actions.

## Direct Node deployment

Run `node dist/cli.js worker` on a separate isolated worker host/container with `INSPECTOR_WORKER_TOKEN_FILE` and `INSPECTOR_WORKER_HOST` configured. Do not mount controller data or identity secrets there. Keep the worker endpoint private; use HTTPS for communication across hosts. The worker defaults to port 8799. Then install Node.js 24.13+, production dependencies, Chromium/system libraries and the built UI as described in the README. Run under a dedicated non-root account and a service manager. Set:

| Variable                            | Purpose                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `INSPECTOR_WORKER_URL`              | Exact private worker origin; HTTPS across hosts, `http://worker:8799` within Compose |
| `INSPECTOR_WORKER_TOKEN_FILE`       | Private file containing the shared worker token                                      |
| `INSPECTOR_SIGNUP`                  | `invite_only` (default) or `self_service`; controls new organization creation        |
| `INSPECTOR_MODE=hosted`             | Enables authenticated organization mode                                              |
| `INSPECTOR_PUBLIC_URL`              | Exact HTTPS origin, with no trailing slash/path/query                                |
| `INSPECTOR_OIDC_ISSUER`             | HTTPS discovery issuer                                                               |
| `INSPECTOR_OIDC_CLIENT_ID`          | Confidential application client ID                                                   |
| `INSPECTOR_OIDC_CLIENT_SECRET_FILE` | Preferred private secret-file path                                                   |
| `INSPECTOR_OIDC_CLIENT_SECRET`      | Alternative secret if no secret file is configured                                   |
| `INSPECTOR_OIDC_REQUIRED_ACR`       | Optional exact authentication-context requirement                                    |
| `INSPECTOR_DATA_DIR`                | Private persistent local directory                                                   |
| `INSPECTOR_HOST`                    | Bind address, default `127.0.0.1`                                                    |
| `INSPECTOR_PORT`                    | Control port, default `8795`                                                         |

The CLI does not load `.env` automatically; use your service manager or `node --env-file=.env dist/cli.js`. For invitation-only deployments, provision using the same data directory before serving. For self-service deployments, new organizations are created through the account portal. Missing identity settings, invalid public origins or provider discovery failures prevent hosted startup.

Only the trusted TLS proxy should reach the control port. Preserve the original `Host` header; the service compares it to the configured public origin and does not trust arbitrary forwarded headers. Sign-in throttling is 30 requests per minute per directly connected IP, so clients behind one proxy share this limit. Add edge rate limiting and validate the expected sign-in volume before a larger rollout.

## Pilot acceptance

Use two actual pilot companies and your configured provider to verify sign-in, MFA, claim mapping, project restrictions, evidence access, logout and owner transfer. Run representative authorized staging checks, restore a backup onto a replacement host, and validate your network policy and monitoring. The repository's signed synthetic-provider tests verify protocol behavior but do not establish compatibility with every provider configuration.

## Upgrade from 0.2 / 0.3

Stop the old controller and take a verified offline backup. Build the new image, provision the worker token and start the updated Compose stack. The controller migrates SQLite to schema 4, adding accounts, organization registrations and invitations. Existing identities retain their issuer/subject bindings. Registration remains invitation-only unless explicitly enabled. Do not run an older binary on the upgraded database; restore the verified pre-upgrade backup to a separate directory for rollback. Existing organizations, projects, evidence and reviews remain available; each hosted origin must be verified before its next inspection. Retention defaults to disabled, so the upgrade itself does not remove existing reports.

The Compose networks separate worker control traffic from the public proxy; the worker has an additional egress network. These networks alone do **not** block access to your host, private networks or cloud metadata. Configure and test host/cloud egress policy for those destinations. The worker token authorizes browser jobs, so keep the endpoint private and rotate the token in both services during a coordinated restart.
