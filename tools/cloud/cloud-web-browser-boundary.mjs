import { randomUUID as systemRandomUUID } from "node:crypto";

import { loadAcceptanceCredentials } from "./adr36-web-credentials.mjs";
import { ADR36_PUBLIC_ORIGIN, requireThat, requireUuid } from "./adr36-web-core.mjs";

export const CLOUD_WEB_ORIGIN = ADR36_PUBLIC_ORIGIN;

const ORIGIN_ENVIRONMENT = Object.freeze([
  "LAUNDRY_PUBLIC_ORIGIN",
  "LAUNDRY_WEB_URL",
  "LAUNDRY_API_URL",
  "PLAYWRIGHT_TEST_BASE_URL",
]);
const DATABASE_ENVIRONMENT = Object.freeze([
  "DATABASE_URL",
  "LAUNDRY_DATABASE_URL",
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "PGSERVICE",
]);
const MACHINE_JSON_ENVIRONMENT = "LAUNDRY_CLOUD_WEB_MACHINE_JSON";

function exactOptionalOrigin(value) {
  if (value === undefined) return;
  requireThat(value === CLOUD_WEB_ORIGIN, "CLOUD_BROWSER_ORIGIN_OVERRIDE_REJECTED");
}

/** Validate the configuration without reading credentials or contacting the server. */
export function assertCloudBrowserConfiguration(env = process.env) {
  for (const name of ORIGIN_ENVIRONMENT) exactOptionalOrigin(env[name]);
  for (const name of DATABASE_ENVIRONMENT) {
    requireThat(env[name] === undefined, "CLOUD_BROWSER_DATABASE_ENV_REJECTED");
  }
  const enabled = env.LAUNDRY_CLOUD_WEB_E2E;
  requireThat(enabled === undefined || enabled === "1", "CLOUD_BROWSER_OPT_IN_INVALID");
  const machineJson = env[MACHINE_JSON_ENVIRONMENT];
  requireThat(
    machineJson === undefined || machineJson === "1",
    "CLOUD_BROWSER_MACHINE_JSON_INVALID",
  );
  return Object.freeze({
    origin: CLOUD_WEB_ORIGIN,
    enabled: enabled === "1",
    machineJson: machineJson === "1",
  });
}

export function cloudBrowserMachineJsonRequested(env = process.env) {
  return assertCloudBrowserConfiguration(env).machineJson;
}

/** Live execution is explicit and credentials retain the ADR-36 direct-or-FILE policy. */
export function loadCloudBrowserEnvironment(env = process.env) {
  const configuration = assertCloudBrowserConfiguration(env);
  requireThat(configuration.enabled, "CLOUD_BROWSER_OPT_IN_REQUIRED");
  return Object.freeze({
    origin: configuration.origin,
    machineJson: configuration.machineJson,
    credentials: loadAcceptanceCredentials(env),
  });
}

function compactTimestamp(now) {
  requireThat(now instanceof Date && Number.isFinite(now.getTime()), "CLOUD_BROWSER_CLOCK_INVALID");
  return now.toISOString().replace(/[-:.]/gu, "").replace("000Z", "Z");
}

/** Produce a safe correlation id. The read-only subset creates no business data. */
export function createCloudBrowserRun(options = {}) {
  const now = options.now?.() ?? new Date();
  const uuid = requireUuid((options.randomUUID ?? systemRandomUUID)(), "RANDOM_UUID_INVALID");
  const compact = compactTimestamp(now);
  const suffix = uuid.replaceAll("-", "").slice(0, 8).toLowerCase();
  return Object.freeze({ runId: `CLOUD-BROWSER-${compact}-${suffix}` });
}
