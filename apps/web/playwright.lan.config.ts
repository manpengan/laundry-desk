import { defineConfig } from "@playwright/test";
import { requirePrivateLanHttpsOrigin } from "./src/host/lan-origin.js";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0 || value.trim() !== value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

const origin = requirePrivateLanHttpsOrigin(requiredEnvironment("LAUNDRY_LAN_ORIGIN"));
const certificateSpki = requiredEnvironment("LAUNDRY_TEST_CERT_SPKI");
if (!/^[A-Za-z0-9+/]{43}=$/u.test(certificateSpki)) {
  throw new Error("LAUNDRY_TEST_CERT_SPKI must be one SHA-256 SPKI pin");
}

/** Opt-in LAN acceptance; caller owns PostgreSQL, Fastify, and the HTTPS gateway. */
export default defineConfig({
  testDir: "./e2e-lan",
  timeout: 30_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  use: {
    baseURL: origin,
    ignoreHTTPSErrors: false,
    trace: "on-first-retry",
    headless: true,
    launchOptions: {
      args: [`--ignore-certificate-errors-spki-list=${certificateSpki}`],
    },
  },
  projects: [{ name: "chromium-lan", use: { browserName: "chromium" } }],
});
