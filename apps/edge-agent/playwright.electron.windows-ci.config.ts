import { defineConfig } from "@playwright/test";

process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
export default defineConfig({
  testDir: "./e2e",
  testMatch: "windows-installed-ci.spec.ts",
  timeout: 120_000,
  globalTimeout: 180_000,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"]],
  use: { trace: "off", screenshot: "off", video: "off" },
});
