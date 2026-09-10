import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFile } from "node:fs/promises";

for (const width of [1440, 390])
  test(`saved comparison and original-evidence export at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.addInitScript(() =>
      localStorage.setItem("inspector-welcome-seen", "true"),
    );
    await page.goto("/");
    await page
      .locator(".history-item")
      .filter({ hasText: "Synthetic comparison" })
      .first()
      .click();
    const panel = page.getByRole("region", { name: "Saved run comparison" });
    await panel.getByLabel("Baseline run").selectOption({ index: 1 });
    await expect(panel.locator(".comparison-counts")).toHaveText(
      "1 new1 resolved1 persistent0 unchanged3 unverified",
    );
    await expect(panel).toContainText("inconclusive → missing");
    const download = page.waitForEvent("download");
    await panel.getByRole("button", { name: "Export comparison JSON" }).click();
    const packet = JSON.parse(
      await readFile((await (await download).path())!, "utf8"),
    );
    expect(packet.comparison.counts.unverified).toBe(3);
    expect(packet.originalRuns[0].results[0].status).toBe("failed");
    expect(packet.originalRuns[1].results[0].status).toBe("passed");
    await panel.getByRole("heading", { name: "What changed?" }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: `docs/comparison-${width}.png`,
      fullPage: true,
      animations: "disabled",
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    await page.reload();
    await page
      .locator(".history-item")
      .filter({ hasText: "Synthetic comparison" })
      .first()
      .click();
    await panel.getByLabel("Baseline run").selectOption({ index: 1 });
    await expect(panel).toContainText("1 resolved");
    await page.locator(".history-item").filter({ hasText: "Archived synthetic inspection" }).click();
    await expect(page.getByRole("heading", { name: "Checks need investigation" })).toBeVisible();
  });
