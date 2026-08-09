import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "local-mac.spec.ts",
  timeout: 300_000,
  globalTimeout: 1_200_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"]],
  use: {
    trace: "off",
    screenshot: "off",
  },
});
