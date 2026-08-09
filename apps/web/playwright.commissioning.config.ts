import { defineConfig } from "@playwright/test";

const LOCAL_WEB_URL = "http://127.0.0.1:5173";
const configuredWebUrl = process.env.LAUNDRY_WEB_URL;
if (configuredWebUrl !== undefined && configuredWebUrl !== LOCAL_WEB_URL) {
  throw new Error("LAUNDRY_WEB_URL must equal the local loopback Web endpoint");
}

/** Runs first against the untouched production bootstrap; no SQL global setup is allowed. */
export default defineConfig({
  testDir: "./e2e-commissioning",
  testMatch: "staff-lifecycle.spec.ts",
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: LOCAL_WEB_URL,
    trace: "off",
    screenshot: "off",
    video: "off",
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
