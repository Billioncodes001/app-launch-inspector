import type { CheckResult } from "./contracts.js";

const confirmedSummaries = new Set([
  "Page content confirmed",
  "Login behavior confirmed",
  "Access boundary held",
  "Customer journey completed",
]);
export function hasBlockedRequests(result: CheckResult) {
  return (
    !!result.network?.blocked ||
    result.warnings.some((w) =>
      /request was blocked|WebSockets are not supported/.test(w),
    )
  );
}
// Older evidence is immutable. Correct contradictory display text at read time,
// without claiming destinations that those older workers did not record.
export function resultSummary(result: CheckResult) {
  if (
    result.status !== "inconclusive" ||
    !confirmedSummaries.has(result.summary)
  )
    return result.summary;
  return hasBlockedRequests(result)
    ? result.kind === "page"
      ? "Expected text found; inspection limited"
      : "Behavior observed; inspection limited"
    : "Behavior observed; evidence incomplete";
}
export function resultGuidance(result: CheckResult) {
  if (result.status !== "inconclusive" || !hasBlockedRequests(result))
    return result.recommendation;
  const reasons = new Set(result.network?.destinations.map((d) => d.reason));
  if (reasons.size === 1 && reasons.has("request_budget"))
    return "This page exceeded 250 requests in one browser session. Reduce the test page’s request volume and rerun the check.";
  if (reasons.size === 1 && reasons.has("websocket"))
    return "This inspection cannot verify behavior that depends on WebSockets. Use a test deployment that works without them, then rerun.";
  return "Review the blocked requests. Use a test deployment that serves its dependencies from the configured origin, then rerun. Cross-origin dependencies and external sign-in flows are not supported in this release.";
}
