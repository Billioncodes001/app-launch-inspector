import type { Run, ResultStatus } from "./contracts.js";
import { HttpError } from "./errors.js";

export function compatibleRuns(before: Run, after: Run) {
  return (
    before.id !== after.id &&
    !!before.projectRevision &&
    before.projectId === after.projectId &&
    before.projectRevision === after.projectRevision &&
    before.target === after.target &&
    before.total === after.total &&
    Number.isFinite(Date.parse(before.createdAt)) &&
    Number.isFinite(Date.parse(after.createdAt)) &&
    Date.parse(before.createdAt) < Date.parse(after.createdAt) &&
    [before, after].every((r) =>
      ["completed", "cancelled", "interrupted"].includes(r.status),
    )
  );
}

type Observation = ResultStatus | "missing";
type Change = "new" | "resolved" | "persistent" | "unchanged" | "unverified";
export function compareRuns(before: Run, after: Run) {
  if (!compatibleRuns(before, after))
    throw new HttpError(
      409,
      "Choose finished runs with distinct timestamps in chronological order from the same target, project and saved configuration revision.",
    );
  for (const run of [before, after]) {
    const indices = run.results.map((r) => r.index);
    if (
      !Number.isInteger(run.total) ||
      run.total < 1 ||
      run.total > 12 ||
      new Set(indices).size !== indices.length ||
      indices.some((i) => !Number.isInteger(i) || i < 0 || i >= run.total)
    )
      throw new HttpError(
        409,
        "Saved check indices are incomplete or inconsistent; comparison is unavailable.",
      );
  }
  const counts: Record<Change, number> = {
    new: 0,
    resolved: 0,
    persistent: 0,
    unchanged: 0,
    unverified: 0,
  };
  const checks = Array.from({ length: after.total }, (_, index) => {
    const a = before.results.find((r) => r.index === index),
      b = after.results.find((r) => r.index === index);
    if (a && b && (a.name !== b.name || a.kind !== b.kind))
      throw new HttpError(
        409,
        "Saved check identities differ; comparison is unavailable.",
      );
    const from: Observation = a?.status ?? "missing",
      to: Observation = b?.status ?? "missing";
    const change: Change =
      !["passed", "failed"].includes(from) || !["passed", "failed"].includes(to)
        ? "unverified"
        : from === "failed"
          ? to === "failed"
            ? "persistent"
            : "resolved"
          : to === "failed"
            ? "new"
            : "unchanged";
    counts[change]++;
    return {
      index,
      name: b?.name ?? a?.name ?? `Check ${index + 1}`,
      from,
      to,
      change,
    };
  });
  return {
    schema: "launch-inspector-comparison/v1",
    baseline: before.id,
    candidate: after.id,
    projectRevision: after.projectRevision,
    target: after.target,
    counts,
    checks,
    limits:
      "New means passed to failed; resolved means failed to passed. Unknown observations are unverified, never resolved. Matching saved configuration does not establish identical browser, deployment or test data. Reviews do not change observations. Screenshot bytes are not embedded.",
  };
}
export type RunComparison = ReturnType<typeof compareRuns>;
