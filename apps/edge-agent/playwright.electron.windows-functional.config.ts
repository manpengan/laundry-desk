import { defineConfig } from "@playwright/test";

// AI error-context snapshots can include credentials even when tracing is disabled.
process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "windows-functional.spec.ts",
  timeout: 360_000,
  globalTimeout: 420_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"]],
  use: {
    trace: "off",
    screenshot: "off",
    video: "off",
  },
});
