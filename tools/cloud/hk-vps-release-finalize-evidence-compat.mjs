import { fail } from "./hk-vps-release-core.mjs";

const API_SCHEMA = "laundry.adr36.api-acceptance-evidence";
const API_VERSION = 1;
const API_RUN_ID = /^ADR36-\d{8}T\d{6}(?:\d{3})?Z-[0-9a-f]{8}$/u;
const API_JOURNEYS = Object.freeze([
  "configuration",
  "dual_admin_auth",
  "staff_credentials",
  "accounting_baseline",
  "catalog_price",
  "synthetic_customer",
  "cash_order_fulfillment",
  "member_lifecycle",
  "accounting_today_delta",
  "order_finance",
  "reporting_exports_shift",
  "reminder_history",
  "safe_cleanup",
  "session_logout",
  "overall",
]);
const API_KEYS = Object.freeze(["results", "run_id", "schema", "version"]);

const BROWSER_SCHEMA = "laundry.cloud-web.browser-evidence";
const BROWSER_VERSION = 1;
const BROWSER_RUN_ID = /^CLOUD-BROWSER-\d{8}T\d{6}(?:\d{3})?Z-[0-9a-f]{8}$/u;
const BROWSER_TEST_TITLE = "core_ui_subset: public Cloud Web read surfaces are reachable";
const BROWSER_RESULTS = Object.freeze([
  Object.freeze({ journey: "configuration", status: "PASS" }),
  Object.freeze({ journey: "core_ui_subset", status: "PASS" }),
  Object.freeze({ journey: "session_logout", status: "PASS" }),
  Object.freeze({ journey: "business_cleanup", status: "NOT_REQUIRED" }),
  Object.freeze({ journey: "standalone_completion", status: "NOT_AUTHORIZED" }),
]);
const BROWSER_KEYS = Object.freeze([
  "results",
  "retries",
  "run_id",
  "schema",
  "test_count",
  "test_status",
  "test_title",
  "version",
]);
const RESULT_KEYS = Object.freeze(["journey", "status"]);

function invalid() {
  fail("CLOUD_RELEASE_EVIDENCE_NOT_PASSED");
}

function exactKeys(value, keys) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function requireLegacyApiEvidence(value) {
  if (
    !exactKeys(value, API_KEYS) ||
    value.schema !== API_SCHEMA ||
    value.version !== API_VERSION ||
    typeof value.run_id !== "string" ||
    !API_RUN_ID.test(value.run_id) ||
    !Array.isArray(value.results) ||
    value.results.length !== API_JOURNEYS.length
  ) {
    invalid();
  }
  const results = API_JOURNEYS.map((journey, index) => {
    const entry = value.results[index];
    if (!exactKeys(entry, RESULT_KEYS) || entry.journey !== journey || entry.status !== "PASS") {
      invalid();
    }
    return Object.freeze({ journey, status: "PASS" });
  });
  return Object.freeze({
    schema: API_SCHEMA,
    version: API_VERSION,
    run_id: value.run_id,
    results: Object.freeze(results),
  });
}

function requireLegacyBrowserEvidence(value) {
  if (
    !exactKeys(value, BROWSER_KEYS) ||
    value.schema !== BROWSER_SCHEMA ||
    value.version !== BROWSER_VERSION ||
    typeof value.run_id !== "string" ||
    !BROWSER_RUN_ID.test(value.run_id) ||
    value.test_count !== 1 ||
    value.test_title !== BROWSER_TEST_TITLE ||
    value.test_status !== "PASS" ||
    value.retries !== 0 ||
    !Array.isArray(value.results) ||
    value.results.length !== BROWSER_RESULTS.length
  ) {
    invalid();
  }
  const results = BROWSER_RESULTS.map((expected, index) => {
    const entry = value.results[index];
    if (
      !exactKeys(entry, RESULT_KEYS) ||
      entry.journey !== expected.journey ||
      entry.status !== expected.status
    ) {
      invalid();
    }
    return expected;
  });
  return Object.freeze({
    schema: BROWSER_SCHEMA,
    version: BROWSER_VERSION,
    run_id: value.run_id,
    test_count: 1,
    test_title: BROWSER_TEST_TITLE,
    test_status: "PASS",
    retries: 0,
    results: Object.freeze(results),
  });
}

export function isLegacyFinalizeEvidenceProfile(api, browser) {
  return (
    api?.schema === API_SCHEMA &&
    api.version === API_VERSION &&
    browser?.schema === BROWSER_SCHEMA &&
    browser.version === BROWSER_VERSION
  );
}

export function requireLegacyFinalizeEvidencePassed(api, browser) {
  return Object.freeze({
    api: requireLegacyApiEvidence(api),
    browser: requireLegacyBrowserEvidence(browser),
  });
}
