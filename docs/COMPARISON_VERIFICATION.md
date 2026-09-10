# Saved Run Comparison Verification

Date: 2026-09-10. One-time enhancement verified locally before coordinated publication. Not a public deployment.

## Scope

Compare saved terminal runs only when project, target and saved configuration revision match. Stable indexed observations classify passed-to-failed as new, failed-to-passed as resolved and failed-to-failed as persistent. All transitions involving skipped, inconclusive or missing checks remain unverified. Accepted-risk reviews do not alter this classification. Original observations, screenshot references and review notes remain available in the comparison JSON export.

No data migration, rerun, automatic review decision or external account activity is introduced. Existing workbench design and organization/project access checks are retained.

## Verification

- Core: 31 tests passed, including all existing regression tests, four new comparison cases and unavailable-browser-channel health coverage.
- Build: server TypeScript, UI TypeScript and Vite production build passed.
- Browser: all 19 scenarios passed. Desktop/mobile comparison selection, actual JSON downloads, reload, accessibility and overflow checks run at 1440 and 390 pixels. The full existing browser suite also covers 320, 768 and 1024 pixels.
- Comparison coverage: all 16 status pairs, absent results, accepted-risk preservation, completed/interrupted runs, changed target/revision/project, reversed ordering, equal-timestamp rejection in both directions, duplicate/out-of-range indices, mismatched check identity, self-comparison, deleted runs and unauthenticated access.
- Hosted API coverage: viewers can export assigned comparisons; both baseline and candidate project scopes are enforced, cross-organization reads fail and revoked membership cannot export.
- Two real browser runs of one saved project observe a local synthetic page before/after a change, classify the failure as resolved, and preserve the earlier results and both screenshot references.

Commands used with Node 24.19.0 and installed Chrome:

```sh
npm run build
TMPDIR=/private/tmp PLAYWRIGHT_CHANNEL=chrome npm test
TMPDIR=/private/tmp PLAYWRIGHT_CHANNEL=chrome INSPECTOR_UI_PORT=5311 INSPECTOR_HOSTED_UI_PORT=5312 npm run test:ui
```

All databases and target/identity fixtures were isolated and synthetic. Application servers used ports 5311/5312; fixture-only local targets use OS-assigned ephemeral ports. No normal preview or user database was accessed.

The initial baseline run lacked dependencies/built assets. After installation/build, a full run exposed macOS temporary-directory symlink rejection and missing bundled Chromium. Using a canonical temporary path preserves the retention security rule. The optional installed-Chrome override is now propagated to workers and verified by an actual startup launch; invalid channels stay unhealthy. The default bundled browser remains unchanged. A slow bundled-browser download was stopped. An existing onboarding accessibility test now waits for its fade to reach full opacity before testing contrast, without weakening assertions.

## Evidence And Limits

- `docs/comparison-1440.png`
- `docs/comparison-390.png`

These are actual UI screenshots of explicitly synthetic saved records, not claims of live-target findings. Original real-browser sample and before/after tests are separate. Configuration equality does not establish identical browser, deployment, external state or test data. Saving a project always creates a different revision, including a no-op save, and intentionally disqualifies older revisions. The picker uses the existing latest-100-run history. Exports include screenshot references rather than image bytes and are not backups or signed certifications. No Docker/CI, customer pilot, real external identity provider, live social source or public deployment was run in this pass.

Suggested portfolio description: Browser-based release review with original evidence, strict same-configuration run comparisons, explicit unknown outcomes and role-protected comparison exports.

## Changed Paths

Implementation: `src/comparison.ts`, `src/server.ts`, `ui/src/comparison.tsx`, `ui/src/main.tsx`, `ui/src/styles.css`.

Installed-browser support: `src/browser-engine.ts`, `src/worker-protocol.ts`, `src/worker-server.ts`.

Tests/configuration: `test/comparison.test.ts`, `test/fixtures/comparison.ts`, `test/hosted.test.ts`, `test/worker.test.ts`, `test/ui/comparison.spec.ts`, `test/ui-server.ts`, `test/hosted-ui-server.ts`, `playwright.config.ts`, `test/ui/account.spec.ts`, `test/ui/organization.spec.ts`, `test/ui/onboarding.spec.ts`.

Documentation: `README.md`, this file, and both `docs/comparison-*.png` screenshots.
