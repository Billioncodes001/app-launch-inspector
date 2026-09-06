# Hosting and customer onboarding

Launch Inspector 0.2 runs as one service with separate customer organizations. This guide targets a dedicated Linux host and Docker Compose v2. Windows supports local development. Review [security boundaries](SECURITY.md) and [operations](OPERATIONS.md) before onboarding customer data.

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
# Optional: provider-specific required authentication context
# INSPECTOR_OIDC_REQUIRED_ACR=your-mfa-context
```

Create `secrets/oidc_client_secret.txt` containing only the client secret. Protect the parent directory and `.env` with owner-only host permissions. Compose mounts that file as a secret; ensure UID 1000 can read it in the container. Neither `.env` nor `secrets/` is tracked by Git or included in the Docker build context.

```sh
docker compose config --quiet
docker compose build
```

Compose forces hosted mode, constructs the HTTPS public origin from `INSPECTOR_DOMAIN` and reads the secret through `INSPECTOR_OIDC_CLIENT_SECRET_FILE`. It uses a persistent named volume at `/data` and automatic TLS through Caddy. Pin reviewed container image digests in your release process and rebuild for browser/runtime security updates.

## 4. Provision the first company

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

Replace all example values. Repeat `--target` for additional approved origins, up to 50. Target DNS must resolve to public addresses and use valid HTTPS. The service operator is responsible for confirming that the company is authorized to inspect these origins; creating an organization is not automated domain-ownership verification.

The owner signs in with the exact approved, verified email. The first successful sign-in binds that membership to the issuer and subject; merely presenting the same email later from a different subject does not take it over. No invitation email is sent by Launch Inspector. An organization owner can add more approved emails through **Organization controls → People & access**.

To provision another company, schedule a brief maintenance window, stop the inspector, run `org-create` again, then start it. The data-directory lease prevents provisioning while a service is active. Approved target origins are established at provisioning in this release; there is no self-service target-approval workflow.

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

Install Node.js 24.13+, production dependencies, Chromium/system libraries and the built UI as described in the README. Run under a dedicated non-root account and a service manager. Set:

| Variable                            | Purpose                                               |
| ----------------------------------- | ----------------------------------------------------- |
| `INSPECTOR_MODE=hosted`             | Enables authenticated organization mode               |
| `INSPECTOR_PUBLIC_URL`              | Exact HTTPS origin, with no trailing slash/path/query |
| `INSPECTOR_OIDC_ISSUER`             | HTTPS discovery issuer                                |
| `INSPECTOR_OIDC_CLIENT_ID`          | Confidential application client ID                    |
| `INSPECTOR_OIDC_CLIENT_SECRET_FILE` | Preferred private secret-file path                    |
| `INSPECTOR_OIDC_CLIENT_SECRET`      | Alternative secret if no secret file is configured    |
| `INSPECTOR_OIDC_REQUIRED_ACR`       | Optional exact authentication-context requirement     |
| `INSPECTOR_DATA_DIR`                | Private persistent local directory                    |
| `INSPECTOR_HOST`                    | Bind address, default `127.0.0.1`                     |
| `INSPECTOR_PORT`                    | Control port, default `8795`                          |

The CLI does not load `.env` automatically; use your service manager or `node --env-file=.env dist/cli.js`. Provision using the same data directory before serving. Missing identity settings, invalid public origins or provider discovery failures prevent hosted startup.

Only the trusted TLS proxy should reach the control port. Preserve the original `Host` header; the service compares it to the configured public origin and does not trust arbitrary forwarded headers. Sign-in throttling is 30 requests per minute per directly connected IP, so clients behind one proxy share this limit. Add edge rate limiting and validate the expected sign-in volume before a larger rollout.

## Pilot acceptance

Use two actual pilot companies and your configured provider to verify sign-in, MFA, claim mapping, project restrictions, evidence access, logout and owner transfer. Run representative authorized staging checks, restore a backup onto a replacement host, and validate your network policy and monitoring. The repository's signed synthetic-provider tests verify protocol behavior but do not establish compatibility with every provider configuration.
