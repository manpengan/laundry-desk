import { defineConfig } from "@playwright/test";

const LOCAL_WEB_URL = "http://127.0.0.1:5173";
const configuredWebUrl = process.env.LAUNDRY_WEB_URL;
if (configuredWebUrl !== undefined && configuredWebUrl !== LOCAL_WEB_URL) {
  throw new Error("LAUNDRY_WEB_URL must equal the local loopback Web endpoint");
}

/**
 * Opt-in local SPA config. Does not start webServer — caller must run:
 *   pnpm local:up
 *   pnpm local:web
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  use: {
    baseURL: LOCAL_WEB_URL,
    trace: "on-first-retry",
    headless: true,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
