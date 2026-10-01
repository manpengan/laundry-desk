import { defineConfig } from "@playwright/test";

// Playwright error-context snapshots can include credentials without tracing.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "windows-offline.spec.ts",
  timeout: 4_800_000,
  globalTimeout: 5_400_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"]],
  use: { trace: "off", screenshot: "off", video: "off" },
});
