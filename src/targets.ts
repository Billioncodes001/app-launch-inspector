import { randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { resolveTxt } from "node:dns/promises";
import { Agent, request } from "undici";
import { Access } from "./access.js";
import { targetPolicy } from "./network.js";
import { HttpError } from "./errors.js";
import type { Actor, TargetProof } from "./contracts.js";
export class Targets {
  constructor(
    readonly access: Access,
    readonly allowLoopbackForTests = false,
  ) {}
  list(org: string): TargetProof[] {
    return this.access.organization(org).origins.map((origin) => {
      const row = this.access.database.sql
        .prepare(
          "SELECT * FROM target_proofs WHERE organization_id=? AND origin=?",
        )
        .get(org, origin);
      return {
        origin,
        status:
          row?.verified_until &&
          String(row.verified_until) > new Date().toISOString()
            ? "verified"
            : row?.verified_until
              ? "expired"
              : row
                ? "pending"
                : "unverified",
        version: Number(row?.version ?? 0),
        verifiedUntil: row?.verified_until
          ? String(row.verified_until)
          : undefined,
        issuedAt: row ? String(row.issued_at) : undefined,
        recordName: "_launch-inspector." + new URL(origin).hostname,
        filePath: "/.well-known/launch-inspector.txt",
        value: row
          ? "launch-inspector=" + org + "." + String(row.token)
          : undefined,
      };
    });
  }
  private approved(org: string, origin: string) {
    if (!this.access.organization(org).origins.includes(origin))
      throw new HttpError(
        403,
        "This origin has not been approved by the service operator",
      );
  }
  challenge(org: string, origin: string, version: number, actor: Actor) {
    this.approved(org, origin);
    return this.access.database.transaction(() => {
      const old = this.list(org).find((p) => p.origin === origin)!;
      if (old.version !== version)
        throw new HttpError(
          409,
          "Target verification changed. Reload before creating another challenge.",
        );
      if (old.status === "verified")
        throw new HttpError(
          409,
          "This target is already verified. Renew it using its existing verification record.",
        );
      this.access.database.sql
        .prepare(
          "INSERT INTO target_proofs VALUES(?,?,?,?,NULL,?) ON CONFLICT(organization_id,origin) DO UPDATE SET token=excluded.token,issued_at=excluded.issued_at,verified_until=NULL,version=excluded.version",
        )
        .run(
          org,
          origin,
          randomBytes(24).toString("hex"),
          new Date().toISOString(),
          version + 1,
        );
      this.access.database.audit(
        org,
        actor,
        "target.challenge_created",
        origin,
      );
      return this.list(org).find((p) => p.origin === origin)!;
    });
  }
  async verify(
    org: string,
    origin: string,
    version: number,
    method: "https" | "dns",
    actor: Actor,
    reauthorize: () => void = () => {},
  ) {
    this.approved(org, origin);
    const proof = this.list(org).find((p) => p.origin === origin)!;
    if (!proof.value || proof.version !== version)
      throw new HttpError(409, "Create a current verification challenge first");
    if (
      !proof.verifiedUntil &&
      Date.now() - Date.parse(proof.issuedAt!) > 86400000
    )
      throw new HttpError(
        409,
        "This challenge expired. Create a new verification record.",
      );
    const policy = await targetPolicy(origin, [], this.allowLoopbackForTests);
    let records: string[] = [];
    if (method === "dns") {
      if (isIP(new URL(origin).hostname))
        throw new HttpError(400, "DNS verification requires a domain name");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        records = (
          await Promise.race([
            resolveTxt(proof.recordName),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new HttpError(408, "DNS verification timed out")),
                5000,
              );
            }),
          ])
        ).map((p) => p.join(""));
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, "The verification TXT record was not found");
      } finally {
        if (timer) clearTimeout(timer);
      }
    } else {
      const agent = new Agent({
        connect: {
          lookup: (_hostname, options, callback) => {
            if (options.all)
              callback(null, [
                { address: policy.address, family: isIP(policy.address) },
              ]);
            else callback(null, policy.address, isIP(policy.address));
          },
        },
      });
      let body: Awaited<ReturnType<typeof request>>["body"] | undefined;
      try {
        const response = await request(origin + proof.filePath, {
          dispatcher: agent,
          headersTimeout: 5000,
          bodyTimeout: 5000,
          signal: AbortSignal.timeout(8000),
          headers: {
            Accept: "text/plain",
            "User-Agent": "Launch-Inspector-Verification/0.3",
          },
        });
        body = response.body;
        if (response.statusCode !== 200)
          throw new HttpError(
            400,
            "Serve the verification file directly with HTTP 200; redirects are not accepted",
          );
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of body) {
          size += chunk.length;
          if (size > 4096)
            throw new HttpError(
              400,
              "Verification files must be no larger than 4 KB",
            );
          chunks.push(Buffer.from(chunk));
        }
        records = Buffer.concat(chunks)
          .toString("utf8")
          .split(/\r?\n/)
          .map((s) => s.trim());
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(
          400,
          "The verification file could not be retrieved securely",
        );
      } finally {
        // Undici emits an abort error when an unread redirect body is destroyed.
        // Observe that cleanup error while preserving the verification failure.
        body?.on("error", () => undefined);
        body?.destroy();
        await agent.destroy();
      }
    }
    const expected = Buffer.from(proof.value);
    if (
      !records.some((s) => {
        const value = Buffer.from(s);
        return (
          value.length === expected.length && timingSafeEqual(value, expected)
        );
      })
    )
      throw new HttpError(
        400,
        "The published record does not match this organization's challenge",
      );
    reauthorize();
    return this.access.database.transaction(() => {
      const expires = new Date(Date.now() + 30 * 86400000).toISOString();
      const update = this.access.database.sql
        .prepare(
          "UPDATE target_proofs SET verified_until=?,version=version+1 WHERE organization_id=? AND origin=? AND version=?",
        )
        .run(expires, org, origin, version);
      if (update.changes !== 1)
        throw new HttpError(
          409,
          "The challenge changed during verification; retry with the current record",
        );
      this.access.database.audit(org, actor, "target.verified", origin, {
        method,
        verifiedUntil: expires,
      });
      return this.list(org).find((p) => p.origin === origin)!;
    });
  }
  assertVerified(org: string, origin: string) {
    if (
      !this.list(org).some(
        (p) => p.origin === origin && p.status === "verified",
      )
    )
      throw new HttpError(
        403,
        "Verify this target in Workspace controls before running an inspection. Verification lasts 30 days.",
      );
  }
}
