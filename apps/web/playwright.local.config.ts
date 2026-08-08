import { defineConfig } from "@playwright/test";

const LOCAL_WEB_URL = "http://127.0.0.1:5173";
const configuredWebUrl = process.env.LAUNDRY_WEB_URL;
if (configuredWebUrl !== undefined && configuredWebUrl !== LOCAL_WEB_URL) {
  throw new Error("LAUNDRY_WEB_URL must equal the local loopback Web endpoint");
}

/** Opt-in local SPA config. Fastify remains caller-owned; Playwright owns Vite. */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.mjs",
  timeout: 30_000,
  fullyParallel: false,
  // Six suites reuse the bootstrap administrator. Keep concurrent password
  // attempts below the server's fail-closed per-account reservation limit (5).
  workers: 4,
  forbidOnly: !!process.env.CI,
  retries: 0,
  use: {
    baseURL: LOCAL_WEB_URL,
    trace: "on-first-retry",
    headless: true,
  },
  webServer: {
    command: "pnpm --filter @laundry/web exec vite --config vite.config.ts",
    url: LOCAL_WEB_URL,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
