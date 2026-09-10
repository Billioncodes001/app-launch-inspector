import type { Store } from "../../src/store.js";
import type { CheckResult, ResultStatus } from "../../src/contracts.js";
import { demoProject } from "../../src/demo.js";

export function comparisonFixture(
  store: Store,
  origin = "http://127.0.0.1:5314",
) {
  const names = [
    "Public landing",
    "Private resource",
    "Sign-in page",
    "Profile save",
    "Document listing",
    "Account settings",
  ];
  const project = store.saveProject({
    ...demoProject(origin, "fixed"),
    name: "Synthetic comparison",
    accounts: [],
    checks: names.map((name) => ({
      kind: "page",
      name,
      path: "/",
      expectedText: "Synthetic content",
    })),
  });
  function run(date: string, statuses: ResultStatus[]) {
    const saved = store.createRun(store.getProject(project.id));
    saved.createdAt = date;
    saved.finishedAt = date;
    saved.status = "completed";
    saved.results = statuses.map(
      (status, index): CheckResult => ({
        index,
        name: names[index],
        kind: "page",
        status,
        severity: status === "failed" ? "medium" : "info",
        summary: "Synthetic saved observation",
        expected: "Synthetic content",
        observed: `Fixture status: ${status}`,
        recommendation: "Review the original observation",
        steps: ["Synthetic comparison fixture; no target contacted"],
        durationMs: 10,
        screenshots: [],
        warnings: [],
      }),
    );
    store.saveRun(saved);
    return saved;
  }
  return {
    project,
    before: run("2026-01-01T12:00:00.000Z", [
      "failed",
      "failed",
      "passed",
      "failed",
      "passed",
      "inconclusive",
    ]),
    after: run("2026-01-02T12:00:00.000Z", [
      "passed",
      "failed",
      "failed",
      "inconclusive",
      "skipped",
    ]),
  };
}
