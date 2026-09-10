import { defineConfig } from "@playwright/test";
const localOrigin = `http://127.0.0.1:${process.env.INSPECTOR_UI_PORT || 8797}`;
const hostedOrigin = `http://127.0.0.1:${process.env.INSPECTOR_HOSTED_UI_PORT || 8798}`;
export default defineConfig({
  testDir: "test/ui",
  timeout: 60000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "artifacts/ui-results.json" }]],
  use: {
    baseURL: localOrigin,
    viewport: { width: 1440, height: 1000 },
    channel: process.env.PLAYWRIGHT_CHANNEL || "chromium",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "npx tsx test/ui-server.ts",
      url: localOrigin,
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command: "npx tsx test/hosted-ui-server.ts",
      url: hostedOrigin,
      reuseExistingServer: false,
      timeout: 30000,
    },
  ],
});
