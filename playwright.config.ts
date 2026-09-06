import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "test/ui",
  timeout: 60000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "artifacts/ui-results.json" }]],
  use: {
    baseURL: "http://127.0.0.1:8797",
    viewport: { width: 1440, height: 1000 },
    channel: "chromium",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npx tsx test/ui-server.ts",
    url: "http://127.0.0.1:8797",
    reuseExistingServer: false,
    timeout: 30000,
  },
});
