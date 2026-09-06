import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.use({ baseURL: "http://127.0.0.1:8798" });
test("new customer signs up, creates an isolated organization and reaches its setup workspace", async ({
  page,
}) => {
  await page.goto("/signup");
  await expect(
    page.getByRole("heading", { name: "A stronger start for every release." }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Create account with your work identity" })
    .click();
  await page.getByLabel("Demo identity").selectOption("new-owner@example.test");
  await page.getByRole("button", { name: "Continue to workspace" }).click();
  await expect(
    page.getByRole("heading", { name: "Make room for your team." }),
  ).toBeVisible();
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 960 });
    await expect(page.locator(".account-panel")).toHaveCSS("opacity", "1");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    const nameField = await page
      .getByLabel("Organization name", { exact: true })
      .boundingBox();
    const originField = await page.getByLabel("Staging origin").boundingBox();
    expect(nameField!.width).toBeGreaterThan(200);
    expect(originField!.y).toBeGreaterThan(nameField!.y + nameField!.height);
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(
      result.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => n.failureSummary),
      })),
    ).toEqual([]);
    if ([1440, 390].includes(width))
      await page.screenshot({
        path: `artifacts/account-signup-${width}.png`,
        fullPage: true,
        animations: "disabled",
      });
  }
  await page
    .getByLabel("Organization name", { exact: true })
    .fill("Aurora Release Team");
  await page
    .getByLabel("Staging origin")
    .fill("https://staging.aurora.example");
  await page
    .getByRole("button", { name: "Create organization", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Aurora Release Team is ready." }),
  ).toBeVisible();
  await expect(
    page.getByText(/was recorded for operator review/),
  ).toContainText("staging.aurora.example");
  await expect(page.getByLabel("Organization reference")).toHaveValue(
    /^[a-f0-9-]{36}$/,
  );
  await page
    .getByRole("button", { name: "Open organization workspace" })
    .click();
  await expect(page.getByLabel("Organization workspace")).toContainText(
    "Aurora Release Team",
  );
  await expect(page.getByLabel("Organization workspace")).not.toContainText(
    "Northstar",
  );
  await page.getByRole("link", { name: "Account", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your organizations." }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Sign out other sessions", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "This session remains active",
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Sign in with your work account" }),
  ).toBeVisible();
});

test("failed identity verification returns a helpful sign-in screen without an authenticated account", async ({
  page,
}) => {
  await page.goto("/signup");
  await page
    .getByRole("link", { name: "Create account with your work identity" })
    .click();
  await page
    .getByLabel("Demo identity")
    .selectOption("unverified@example.test");
  await page.getByRole("button", { name: "Continue to workspace" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Sign-in could not be completed",
  );
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByRole("link", { name: "Sign in with your work account" }),
  ).toBeVisible();
  expect(
    (await (await page.request.get("/api/session")).json()).authenticated,
  ).toBe(false);
});

test("local workspace explains hosted signup instead of pretending to register an account", async ({
  page,
}) => {
  await page.goto("http://127.0.0.1:8797/signup");
  await expect(
    page.getByRole("heading", { name: "Hosted accounts, when you need them." }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Create account with your work identity" }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Return to your workspace" }).click();
  await expect(
    page.getByRole("button", { name: "Workspace controls", exact: true }),
  ).toBeVisible();
});
