# Operations and recovery

## Service model

Run **one instance against one persistent local data directory**. SQLite uses WAL mode, foreign keys and synchronous transactions. Organization IDs scope data access and encryption, but organizations share the process, database and root encryption key. Network filesystems and multiple replicas are unsupported.

A service lease prevents a second instance or maintenance command from using an active data directory. It renews every 10 seconds and expires after 90 seconds for a vanished container. Loss of the lease stops the service. After a crash, a replacement container may need to wait for expiry. Do not manually delete a live lease to force a second process to start.

Graceful shutdown cancels queued/running inspections and closes browsers. After an abrupt stop, unfinished records become `interrupted` when the service starts. They are never replayed automatically. The default execution budget is 180 seconds, including waiting for global browser capacity.

## Health and capacity

`GET /healthz` returns `200` with `{"status":"ready","version":"0.2.0"}` when the lease, database, browser executable and runner storage state are available. It returns `503` when stopping or unhealthy. Requests still require the configured Host header. Health responses contain no company information. The endpoint does not prove that every target, identity-provider request or browser launch will succeed.

```sh
docker compose ps
docker compose logs --tail=100 inspector
```

Unexpected HTTP errors emit a structured event and request ID without request bodies or credentials. HTTP responses include `X-Request-ID` for correlation. Add infrastructure monitoring for health, restarts, memory, disk capacity, backup age and TLS expiry. A metrics endpoint, alert delivery and centralized tracing are not implemented.

| Limit                                    | Current value                               |
| ---------------------------------------- | ------------------------------------------- |
| Active inspections                       | 1 per organization, 2 across the service    |
| Active + queued inspections              | 5 per organization, 20 across the service   |
| Projects / members                       | 100 each per organization                   |
| Accounts / checks / journey steps        | 6 / 12 / 12 per target                      |
| Run budget / navigation / locator wait   | 180 s / 15 s / 6 s                          |
| Requests per browser context             | 250                                         |
| API request size / simultaneous requests | 256,000 bytes / 24                          |
| API rate                                 | 300 requests per minute per signed-in actor |
| Session lifetime                         | 12 hours absolute, 30 minutes idle          |

Background workspace polling does not extend the idle session. A full queue returns an explicit error. There is no throughput or availability SLA; measure representative workloads before a commercial commitment.

## Back up

Stop the service first. Backup copies the root key, checkpointed SQLite database, screenshots and any retained legacy configuration into a **new directory outside the data directory**. It writes a SHA-256 manifest, verifies the files and records the backup in audit history.

Direct Node, with `INSPECTOR_DATA_DIR` set to the actual service directory:

```sh
node dist/cli.js backup --output /private/backups/inspector-2026-09-06
node dist/cli.js verify-backup --input /private/backups/inspector-2026-09-06
```

The parent directory must already exist and be writable by the service account. Backups refuse active services, unresolved queued/running records, symlinks and existing output directories. After a crash, start then stop the service to mark unfinished records interrupted before backing up.

Compose example, after creating a private host `backups` directory writable by UID/GID 1000:

```sh
docker compose stop inspector
docker compose run --rm --no-deps -v "$PWD/backups:/backups" inspector \
  node dist/cli.js backup --output /backups/inspector-2026-09-06
docker compose run --rm --no-deps -v "$PWD/backups:/backups:ro" inspector \
  node dist/cli.js verify-backup --input /backups/inspector-2026-09-06
docker compose up -d
```

Store encrypted copies off the host under separate access control. The backup contains both the encryption key and sensitive evidence. Checksums detect accidental damage; someone able to replace the files and manifest can forge them. Use a trusted backup service with its own integrity and retention protections. Partial failed backups are left for operator inspection and are not valid snapshots.

## Restore

Verify the snapshot, then restore into a new path; restoration never overwrites an existing data directory:

```sh
node dist/cli.js restore \
  --input /private/backups/inspector-2026-09-06 \
  --output /private/recovered-inspector
```

Restore checks database integrity, foreign keys and audit chains. It clears all sessions, pending sign-in transactions and the old lease; users must sign in again. Project secrets remain recoverable with the copied key. A restoration event is added to each organization's audit history. If validation fails after copying, keep the service pointed at its existing data and investigate the incomplete output.

For Compose, mount private host recovery storage writable by UID 1000 and restore there:

```sh
docker compose stop inspector
docker compose run --rm --no-deps \
  -v "$PWD/backups:/backups:ro" -v "$PWD/recovery:/recovery" inspector \
  node dist/cli.js restore --input /backups/inspector-2026-09-06 --output /recovery/data
```

Change the inspector's `/data` mount in a deployment override to `./recovery/data:/data`, then start the replacement service. Keep the original named volume intact until recovery is verified. Confirm organization counts, a decrypted target, a screenshot, audit history, new sign-in and an authorized sample inspection. Never use `docker compose down -v` as part of routine recovery.

## Upgrade and rollback

1. Schedule maintenance and stop the service.
2. Create and verify a full backup. Preserve the deployed image digest and environment/secret configuration separately.
3. Build or pull the reviewed release and start one instance with the existing volume.
4. Check health, sign-in, project lists, historical evidence and one authorized inspection.
5. If rollback is needed, restore the pre-upgrade snapshot to a new path and run the matching previous release. Do not run an older binary against a newer schema.

For the first upgrade from v0.1, take a filesystem copy of the entire stopped data directory before starting v0.2. Startup imports encrypted projects and old run records transactionally into the local organization and retains the originals. New hosted organizations do not inherit local projects or credentials. Legacy screenshots remain readable from their original locations.

## Retention, privacy and audit

There is no automated record/evidence deletion or encryption-key rotation command yet. Account for all retained data in disk sizing and customer retention agreements. The dashboard's 100-run history limit is a display limit, not deletion. Do not remove database rows or screenshot directories by hand while the service is running. A supported per-company deletion and retention workflow is required before promising automated lifecycle controls.

Audit records use a per-organization keyed chain. Verification detects modifications to existing records when the attacker does not possess the root key; it is not immutable storage. A root-key holder can rewrite and resign records, and suffix deletion needs an externally recorded chain head to be detected. Export audit data and chain heads to independently controlled storage when your operating requirements need stronger evidence.

Protect `master.key`, the database/WAL, legacy files, screenshots and snapshots as one sensitive data set. Losing the key loses project-secret recovery. Run the service under a dedicated account; POSIX modes do not replace Windows ACLs or cloud storage permissions.
