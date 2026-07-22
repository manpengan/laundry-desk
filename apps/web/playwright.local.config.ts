import { defineConfig } from "@playwright/test";

/**
 * Opt-in local SPA config. Does not start webServer — caller must run:
 *   pnpm local:server:pg   # or local:server
 *   pnpm local:web
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  use: {
    baseURL: process.env.LAUNDRY_WEB_URL ?? "http://127.0.0.1:5173",
    trace: "on-first-retry",
    headless: true,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
