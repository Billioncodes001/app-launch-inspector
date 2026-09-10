import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("inspector-welcome-seen", "true"),
  );
});
test.use({
  baseURL: `http://127.0.0.1:${process.env.INSPECTOR_HOSTED_UI_PORT || 8798}`,
});
async function login(page: Page, email = "owner-a@example.test") {
  await page.goto("/");
  await page
    .getByRole("link", { name: "Sign in with your work account" })
    .click();
  await page.getByLabel("Demo identity").selectOption(email);
  await page.getByRole("button", { name: "Continue to workspace" }).click();
  await page
    .getByRole("heading", { name: "Inspection workbench", exact: true })
    .waitFor();
  await page
    .getByLabel("Organization workspace")
    .selectOption({ label: "Northstar Labs" });
  await expect(page.getByLabel("Organization workspace")).toHaveValue(/.+/);
}
async function axe(page: Page) {
  await expect(page.locator("main > div").last()).toHaveCSS("opacity", "1");
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    result.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.failureSummary),
    })),
  ).toEqual([]);
}
test("hosted sign-in, real inspection, review and audit history work through the browser", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Your release checkpoint." }),
  ).toBeVisible();
  await axe(page);
  await login(page);
  await page
    .getByLabel("Inspection target", { exact: true })
    .selectOption({ label: "Northstar staging" });
  await page
    .getByRole("checkbox", { name: /I authorize these checks/ })
    .check();
  await page
    .getByRole("button", { name: "Run inspection", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Findings to resolve" }),
  ).toBeVisible({ timeout: 30000 });
  await page.getByLabel("Review status").selectOption("accepted_risk");
  await page
    .getByLabel("Review note")
    .fill(
      "Synthetic review: track the authorization repair before customer release.",
    );
  await page.getByRole("button", { name: "Save review", exact: true }).click();
  await expect(page.locator(".review-record")).toContainText(
    "Synthetic review",
  );
  await expect(page.locator(".result-summary")).toContainText("4 failed");
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Report", exact: true }).click();
  const file = await downloadEvent;
  expect(file.suggestedFilename()).toMatch(/\.md$/);
  await page.getByRole("button", { name: "Organization controls" }).click();
  await page
    .getByRole("button", { name: "Audit history", exact: true })
    .click();
  await expect(page.getByText(/Integrity check passed/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "finding / accepted risk", exact: true }),
  ).toBeVisible();
  await axe(page);
  await page.screenshot({
    path: "artifacts/organization-audit-1440.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await axe(page);
  await page.screenshot({
    path: "artifacts/organization-audit-390.png",
    fullPage: true,
    animations: "disabled",
  });
});
test("owner can invite a scoped member, the recipient accepts, and access can be edited and removed", async ({
  page,
  browser,
}) => {
  await login(page);
  await page.getByRole("button", { name: "Organization controls" }).click();
  await page
    .getByLabel("Work email", { exact: true })
    .fill("new-reviewer@example.test");
  await page.getByLabel("Organization role").selectOption("viewer");
  await page.getByLabel("Restrict to selected projects").check();
  await page
    .getByRole("checkbox", { name: "Northstar staging", exact: true })
    .check();
  await page
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  await expect(
    page
      .locator(".pending-invite")
      .filter({ hasText: "new-reviewer@example.test" }),
  ).toContainText("1 projects");
  await expect(
    page
      .locator(".member-row")
      .filter({ hasText: "new-reviewer@example.test" }),
  ).toHaveCount(0);
  const recipient = await browser.newContext();
  try {
    const join = await recipient.newPage();
    await join.goto(
      `http://127.0.0.1:${process.env.INSPECTOR_HOSTED_UI_PORT || 8798}/join`,
    );
    await join
      .getByRole("link", { name: "Sign in with your work account" })
      .click();
    await join
      .getByLabel("Demo identity")
      .selectOption("new-reviewer@example.test");
    await join.getByRole("button", { name: "Continue to workspace" }).click();
    await expect(
      join.getByRole("heading", { name: "Join your team." }),
    ).toBeVisible();
    await join.getByRole("button", { name: "Accept invitation" }).click();
    await expect(join.getByLabel("Organization workspace")).toContainText(
      "Northstar Labs",
    );
  } finally {
    await recipient.close();
  }
  await page.reload();
  await page.getByRole("button", { name: "Organization controls" }).click();
  const row = page
    .locator(".member-row")
    .filter({ hasText: "new-reviewer@example.test" });
  await expect(row).toContainText("1 projects");
  await row
    .getByRole("button", { name: "Edit new-reviewer@example.test" })
    .click();
  await page.getByLabel("Organization role").selectOption("editor");
  await page.getByRole("button", { name: "Save access", exact: true }).click();
  await expect(row).toContainText("editor");
  await page.setViewportSize({ width: 390, height: 900 });
  await axe(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "artifacts/organization-people-390.png",
    fullPage: true,
    animations: "disabled",
  });
  await row
    .getByRole("button", { name: "Remove new-reviewer@example.test" })
    .click();
  await page.getByRole("button", { name: "Keep access", exact: true }).click();
  await expect(row).toBeVisible();
  await row
    .getByRole("button", { name: "Remove new-reviewer@example.test" })
    .click();
  await page
    .getByRole("button", { name: "Remove access", exact: true })
    .click();
  await expect(row).toHaveCount(0);
});
test("organization switching changes data and controls, and logout requires a fresh sign-in", async ({
  page,
}) => {
  await login(page);
  await expect(
    page.getByRole("button", { name: "New target", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Organization workspace")
    .selectOption({ label: "Harbor Systems" });
  await expect(
    page.getByRole("button", { name: "New target", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Organization controls" }),
  ).toHaveCount(0);
  await page
    .getByLabel("Inspection target", { exact: true })
    .selectOption({ label: "Harbor customer portal" });
  await expect(
    page.getByRole("button", { name: "Edit selected target" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Run inspection", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("#project-select option")).not.toContainText([
    "Northstar staging",
  ]);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Sign in with your work account" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Inspection workbench" }),
  ).toHaveCount(0);
});
test("viewer sees only assigned projects and no editing, authorization or demo controls", async ({
  page,
}) => {
  await login(page, "viewer-a@example.test");
  await page
    .getByLabel("Inspection target", { exact: true })
    .selectOption({ label: "Northstar staging" });
  await expect(
    page.getByRole("button", { name: "New target", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Organization controls" }),
  ).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /I authorize/ })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Run faulty sample" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Edit selected target" }),
  ).toBeDisabled();
  await page.setViewportSize({ width: 320, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await axe(page);
});
