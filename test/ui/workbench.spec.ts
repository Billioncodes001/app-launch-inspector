import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("initial workspace is accessible and responsive at five widths", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Inspection workbench", exact: true }),
  ).toBeVisible();
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.locator("main>div").last()).not.toHaveCSS("opacity", "0");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `artifacts/workbench-${width}.png`,
      fullPage: true,
      animations: "disabled",
    });
    if (width === 1440 || width === 320) {
      const audit = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      expect(
        audit.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => n.failureSummary),
        })),
      ).toEqual([]);
    }
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Skip to inspection workbench" }),
  ).toBeFocused();
});
test("faulty sample detects actual failures and exposes screenshots, reproduction and report downloads", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page
    .getByRole("button", { name: "Run faulty sample", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Findings to resolve" }),
  ).toBeVisible({ timeout: 45000 });
  await expect(page.locator(".result-summary")).toContainText("4 failed");
  await page
    .getByRole("button", { name: /Another member’s private document/ })
    .click();
  await expect(page.locator(".finding")).toContainText(
    "Protected content was visible to the restricted actor",
  );
  await expect(page.locator(".evidence .screenshot img")).toHaveCount(2);
  await page
    .getByRole("button", { name: "Enlarge Observed result", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Report", exact: true }).click();
  expect((await downloaded).suggestedFilename()).toMatch(/^inspection-.*\.md$/);
  await page.screenshot({
    path: "artifacts/findings-1440.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "artifacts/findings-390.png",
    fullPage: true,
    animations: "disabled",
  });
  expect(errors).toEqual([]);
});
test("corrected sample completes six real checks without failures", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Run corrected sample", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Configured checks passed" }),
  ).toBeVisible({ timeout: 45000 });
  await expect(page.locator(".result-summary")).toContainText("6 passed");
  await expect(page.locator(".result-summary")).toContainText("0 failed");
  const audit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    audit.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.failureSummary),
    })),
  ).toEqual([]);
});
test("custom target setup saves, reloads and requires explicit authorization before a run", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New target", exact: true }).click();
  await page
    .getByLabel("Project name", { exact: true })
    .fill("Customer staging");
  const demoOrigin = await page.evaluate(async () => {
    const token = document.querySelector<HTMLMetaElement>(
      'meta[name="inspector-token"]',
    )!.content;
    return (
      await (
        await fetch("/api/state", { headers: { "X-Inspector-Token": token } })
      ).json()
    ).demoOrigin;
  });
  await page.getByLabel("Target origin", { exact: true }).fill(demoOrigin);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel("Page path", { exact: true }).fill("/fixed/");
  await page
    .getByLabel("Expected visible text", { exact: true })
    .fill("A workspace for your team");
  await page.getByRole("button", { name: "Save target", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Inspection workbench", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Run inspection", exact: true }),
  ).toBeDisabled();
  await page.getByLabel(/I authorize these checks/).check();
  await page
    .getByRole("button", { name: "Run inspection", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Configured checks passed" }),
  ).toBeVisible({ timeout: 30000 });
  await page.reload();
  await page
    .getByLabel("Inspection target", { exact: true })
    .selectOption({ label: "Customer staging" });
  await expect(
    page.getByRole("button", { name: "Run inspection", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Edit selected target" }).click();
  await expect(page.getByLabel("Project name", { exact: true })).toHaveValue(
    "Customer staging",
  );
  await expect(page.getByLabel("Target origin", { exact: true })).toHaveValue(
    demoOrigin,
  );
});
test("account and journey builders remain usable on phones and retain saved passwords", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByLabel("Inspection target")
    .selectOption({ label: "Sample app · After fixes" });
  await page.getByRole("button", { name: "Edit selected target" }).click();
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.getByRole("button", { name: /Test accounts/ }).click();
  await expect(
    page.getByLabel("Account 1 password", { exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByText("Saved securely. Leave blank to keep it."),
  ).toHaveCount(3);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: /Inspection checks/ }).click();
  await expect(page.getByLabel("Step 2 value")).toHaveValue("Ready for launch");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Save target", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Inspection workbench", exact: true }),
  ).toBeVisible();
  await page.getByLabel(/I authorize these checks/).check();
  await page
    .getByRole("button", { name: "Run inspection", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Configured checks passed" }),
  ).toBeVisible({ timeout: 45000 });
});
