import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("a visible sign-in marker with blocked assets stays inconclusive and explains the limits", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("inspector-welcome-seen", "true"),
  );
  await page.goto("/");
  await page
    .getByLabel("Inspection target", { exact: true })
    .selectOption({ label: "Dependency diagnostic sample" });
  await page
    .getByRole("checkbox", { name: /I authorize these checks/ })
    .check();
  await page
    .getByRole("button", { name: "Run inspection", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Checks need investigation" }),
  ).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".finding-summary")).toHaveText(
    "Expected text found; inspection limited",
  );
  await expect(page.locator(".observation")).toContainText(
    "Expected content is visible.",
  );
  await expect(page.locator(".run-limit-note")).toContainText(
    "1 check is inconclusive",
  );
  await expect(page.locator(".history-item.selected")).toContainText(
    "1 inconclusive",
  );
  await expect(
    page.getByRole("region", { name: "Inspection network limits" }),
  ).toContainText("https://assets.example.test");
  await expect(page.locator(".network-diagnostics")).toContainText(
    "Outside target origin",
  );
  await expect(page.locator(".network-diagnostics")).toContainText("image");
  expect(await page.locator(".finding").innerText()).not.toContain(
    "private-token",
  );
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `artifacts/dependency-diagnostics-${width}.png`,
      fullPage: true,
      animations: "disabled",
    });
  }
  const audit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(audit.violations).toEqual([]);
});

test("earlier inconclusive reports explain missing diagnostics without rewriting evidence", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("inspector-welcome-seen", "true"),
  );
  await page.goto("/");
  await page.getByRole("button", { name: /Earlier dependency report/ }).click();
  await expect(page.locator(".finding-summary")).toHaveText(
    "Expected text found; inspection limited",
  );
  await expect(page.locator(".network-diagnostics")).toContainText(
    "did not record blocked destinations",
  );
  await expect(page.locator(".finding-summary")).not.toContainText(
    "Page content confirmed",
  );
});
