import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("manual cleanup requires explicit confirmation and removes only the previewed synthetic report", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("inspector-welcome-seen", "true"),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Workspace controls" }).click();
  await page
    .getByRole("button", { name: "Evidence retention", exact: true })
    .click();
  await page.getByRole("button", { name: "Preview cleanup" }).click();
  await expect(page.locator(".cleanup-list")).toContainText(
    "Archived synthetic inspection",
  );
  await page.getByRole("button", { name: "Remove 1 inspections" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Confirmation", { exact: true })).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Delete permanently" }),
  ).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Remove 1 inspections" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Remove 1 inspections" }).click();
  await page.setViewportSize({ width: 320, height: 900 });
  const audit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(audit.violations).toEqual([]);
  await page.screenshot({
    path: "artifacts/cleanup-confirmation-320.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByLabel("Confirmation", { exact: true }).fill("DELETE");
  await page.getByRole("button", { name: "Delete permanently" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(page.getByRole("status")).toContainText("1 inspections removed");
  await page.getByRole("button", { name: "Preview cleanup" }).click();
  await expect(
    page.getByRole("button", { name: "Remove 0 inspections" }),
  ).toBeDisabled();
});

test("guided onboarding is responsive, accessible, and runs a configured real page check", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", {
      name: "Build a clearer picture of your release.",
    }),
  ).toBeVisible();
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.locator(".onboarding img")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `artifacts/onboarding-${width}.png`,
      fullPage: true,
      animations: "disabled",
    });
    if (width === 1440 || width === 320) {
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
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Seed an allowed synthetic target using the existing demo endpoint; onboarding
  // creates its own project and executes the actual page check from user inputs.
  const origin = await page.evaluate(async () => {
    const token = document.querySelector<HTMLMetaElement>(
      'meta[name="inspector-token"]',
    )!.content;
    const r = await fetch("/api/demo", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Inspector-Token": token,
      },
      body: JSON.stringify({ variant: "fixed" }),
    });
    if (!r.ok) throw Error(await r.text());
    return (await r.json()).baseUrl as string;
  });
  await page
    .getByRole("button", { name: "Set up my first inspection" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Start with one important page." }),
  ).toBeFocused();
  await page
    .getByLabel("Project name", { exact: true })
    .fill("Guided first inspection");
  await page.getByLabel("Application origin").fill(origin);
  await page.getByLabel("Page path").fill("/fixed");
  await page.getByLabel("Expected page text").fill("A workspace for your team");
  await page
    .getByRole("button", { name: "Review inspection", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Start first inspection" }),
  ).toBeDisabled();
  await page
    .getByRole("checkbox", {
      name: "I am authorized to inspect this application.",
    })
    .check();
  await page.getByRole("button", { name: "Start first inspection" }).click();
  await expect(
    page.getByRole("heading", { name: "Configured checks passed" }),
  ).toBeVisible({ timeout: 30000 });
  await page.getByText("Evidence retention", { exact: true }).click();
  await page
    .getByLabel("Reason to preserve this report")
    .fill("Keep for the onboarding release review");
  await page.getByRole("button", { name: "Protect evidence" }).click();
  await expect(
    page.getByText("Evidence protected by retention hold", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Inspection workbench", exact: true }),
  ).toBeVisible();
});

test("retention preview and verified-target management are available to an organization owner", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("inspector-welcome-seen", "true"),
  );
  await page.goto("http://127.0.0.1:8798");
  await page
    .getByRole("link", { name: "Sign in with your work account" })
    .click();
  await page.getByLabel("Demo identity").selectOption("owner-a@example.test");
  await page.getByRole("button", { name: "Continue to workspace" }).click();
  await page.getByRole("button", { name: "Organization controls" }).click();
  await page.getByRole("button", { name: "Verified targets" }).click();
  await expect(page.getByText("verified", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Verify file", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Ownership verified");
  await page
    .getByRole("button", { name: "Evidence retention", exact: true })
    .click();
  await page.getByRole("button", { name: "Preview cleanup" }).click();
  await expect(
    page.getByText("eligible inspections", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Remove 0 inspections/ }),
  ).toBeDisabled();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `artifacts/retention-${width}.png`,
      fullPage: true,
      animations: "disabled",
    });
  }
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(result.violations).toEqual([]);
});
