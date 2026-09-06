# Security boundaries

Launch Inspector exercises web applications and stores their test credentials and evidence. Use authorized staging applications and synthetic data. This release implements useful application controls but has not undergone independent penetration testing or formal compliance certification.

## Trust boundaries

| Boundary                          | Implemented controls                                                                                                                            | Remaining responsibility                                                 |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Signed-out visitor → workspace    | Verified OIDC response, PKCE/state/nonce, server session, exact Host/Origin, CSRF and request limits                                            | Configure the provider, MFA, TLS, edge protections and account recovery  |
| Company → another company         | Organization-scoped project/run/review/audit queries and evidence routes; explicit project authorization                                        | Independent isolation testing and infrastructure access policies         |
| Member → owner                    | Server-enforced roles, activated-owner protection, versioned updates                                                                            | Review memberships and remove access when employment or contracts change |
| Target page → browser host        | Same-origin requests, public-address validation and DNS pinning, blocked WebSockets/service workers, bounded resources, hosted Chromium sandbox | Dedicated host, OS/container patching and network egress isolation       |
| Stored configuration → disclosure | AES-256-GCM with organization/project-scoped keys, passwords omitted from API responses                                                         | Protect the shared root key, volumes and backups; encrypt storage        |
| Finding → release decision        | Baseline validation, recorded original results, separate versioned reviews and audit entries                                                    | Interpret evidence and decide whether release risk is acceptable         |

Organization isolation is enforced by application logic in a shared process/database. It is not a separate VM or database per tenant. The browser and controller share a container; do not treat it as an isolation boundary against a browser escape. Larger or higher-risk commercial deployments need a separately isolated worker architecture and independent review.

## Identity and sessions

Approved emails bind to a verified issuer/subject on first sign-in. Membership lookup subsequently uses that identity, not an arbitrary email claim. Sign-in transactions expire after 10 minutes and are single-use. HTTPS cookies use the `__Host-` prefix, Secure, HttpOnly, SameSite=Lax and path `/`. Only session-cookie hashes are stored in the database; authentication flow secrets are encrypted. Provider access/refresh tokens are not retained.

Sessions expire after 12 hours or 30 idle minutes. Routine polling does not count as activity. Removing a membership blocks new requests for that organization, including a still-open session. Identity-provider logout and deactivation alone do not immediately invalidate existing inspector sessions. MFA is a provider policy; the optional required ACR validates a provider-defined authentication context.

Owners see all company projects. Unrestricted editors may create projects; project-restricted editors cannot. Viewers receive no saved passwords, account usernames or journey fill values, but can read assigned reports and screenshots. Treat evidence permission as permission to see target content; masking is not a guarantee that screenshots contain no personal data.

## Browser scope

Hosted target origins are explicitly approved by the service operator and must resolve to public addresses over HTTPS. Private, loopback, link-local and metadata destinations are blocked. Local mode allows loopback targets but must bind its dashboard to loopback. Target DNS is checked before queueing and execution and pinned in Chromium. Other origins, WebSockets and service workers are blocked. The browser process receives a limited environment rather than controller secrets.

These controls do not amount to a complete network sandbox. Use external egress policy and a dedicated host. Browser process compromise, dependency vulnerabilities and kernel escape are outside application-level guarantees. The synthetic organization demo has explicit loopback/HTTP test exceptions that are not available through production CLI settings.

No existing personal browser profile or cookies are imported. Each check uses isolated browser contexts. A successful baseline is required before access restrictions can pass. Checks evaluate visible content and configured actions; they do not prove the absence of API leaks, source vulnerabilities or race conditions.

## Evidence and audit

Project configuration is encrypted at rest. Run records, reviews, member identities and screenshots are not application-encrypted. Text reports redact known passwords and configured form-fill values. Screenshots mask inputs, textareas, marked private elements and exact password text, but other visible data remains possible. Review exports before sharing.

Audit chains are tamper-evident under the root-key trust assumption, not immutable. Operator access, backups and externally retained audit heads require separate controls. See [operations](OPERATIONS.md).

## Reporting a vulnerability

Do not post credentials, customer data, exploit evidence from an unauthorized target or private logs in a public issue. Submit a synthetic minimal reproduction through an agreed private maintainer channel. Include version, operating system, affected boundary and reproducible steps. This repository does not currently promise a security response SLA.
