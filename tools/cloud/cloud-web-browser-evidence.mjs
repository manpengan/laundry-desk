import { asRecord, requireThat } from "./adr36-web-core.mjs";

export const CLOUD_BROWSER_EVIDENCE_SCHEMA = "laundry.cloud-web.browser-evidence";
export const CLOUD_BROWSER_EVIDENCE_VERSION = 1;
export const CLOUD_BROWSER_EVIDENCE_ATTACHMENT = "cloud-web-browser-evidence.json";
export const CLOUD_BROWSER_EVIDENCE_CONTENT_TYPE = "application/json";
export const CLOUD_BROWSER_EXPECTED_TEST_TITLE =
  "core_ui_subset: public Cloud Web read surfaces are reachable";

export const CLOUD_BROWSER_EVIDENCE_JOURNEYS = Object.freeze([
  "configuration",
  "core_ui_subset",
  "session_logout",
  "business_cleanup",
  "standalone_completion",
]);

const TOP_LEVEL_KEYS = Object.freeze([
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
const RUN_ID = /^CLOUD-BROWSER-\d{8}T\d{6}(?:\d{3})?Z-[0-9a-f]{8}$/u;
const TEST_TITLES = new Set([CLOUD_BROWSER_EXPECTED_TEST_TITLE, "NO_TEST", "UNEXPECTED_TEST"]);
const TEST_STATUSES = new Set(["FAIL", "PASS", "SKIPPED"]);
const JOURNEY_STATUSES = Object.freeze({
  configuration: new Set(["FAIL", "PASS"]),
  core_ui_subset: new Set(["FAIL", "PASS"]),
  session_logout: new Set(["FAIL", "PASS"]),
  business_cleanup: new Set(["NOT_REQUIRED"]),
  standalone_completion: new Set(["NOT_AUTHORIZED"]),
});
const REQUIRED_RESULTS = Object.freeze({
  configuration: "PASS",
  core_ui_subset: "PASS",
  session_logout: "PASS",
  business_cleanup: "NOT_REQUIRED",
  standalone_completion: "NOT_AUTHORIZED",
});

function hasExactKeys(record, expected) {
  const actual = Object.keys(record).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requireBoundedInteger(value, code) {
  requireThat(Number.isSafeInteger(value) && value >= 0 && value <= 100, code);
  return value;
}

function requireEvidenceResult(value, expectedJourney) {
  const entry = asRecord(value, "CLOUD_BROWSER_EVIDENCE_RESULT_INVALID");
  requireThat(hasExactKeys(entry, RESULT_KEYS), "CLOUD_BROWSER_EVIDENCE_RESULT_INVALID");
  requireThat(entry.journey === expectedJourney, "CLOUD_BROWSER_EVIDENCE_JOURNEYS_INVALID");
  requireThat(
    typeof entry.status === "string" && JOURNEY_STATUSES[expectedJourney].has(entry.status),
    "CLOUD_BROWSER_EVIDENCE_STATUS_INVALID",
  );
  return Object.freeze({ journey: expectedJourney, status: entry.status });
}

export function requireCloudBrowserRunId(value) {
  requireThat(
    typeof value === "string" && RUN_ID.test(value),
    "CLOUD_BROWSER_EVIDENCE_RUN_ID_INVALID",
  );
  return value;
}

export function requireCloudBrowserEvidence(value) {
  const record = asRecord(value, "CLOUD_BROWSER_EVIDENCE_INVALID");
  requireThat(hasExactKeys(record, TOP_LEVEL_KEYS), "CLOUD_BROWSER_EVIDENCE_INVALID");
  requireThat(
    record.schema === CLOUD_BROWSER_EVIDENCE_SCHEMA,
    "CLOUD_BROWSER_EVIDENCE_SCHEMA_INVALID",
  );
  requireThat(
    record.version === CLOUD_BROWSER_EVIDENCE_VERSION,
    "CLOUD_BROWSER_EVIDENCE_VERSION_INVALID",
  );
  const runId = requireCloudBrowserRunId(record.run_id);
  const testCount = requireBoundedInteger(
    record.test_count,
    "CLOUD_BROWSER_EVIDENCE_TEST_COUNT_INVALID",
  );
  const retries = requireBoundedInteger(record.retries, "CLOUD_BROWSER_EVIDENCE_RETRIES_INVALID");
  requireThat(
    typeof record.test_title === "string" && TEST_TITLES.has(record.test_title),
    "CLOUD_BROWSER_EVIDENCE_TEST_TITLE_INVALID",
  );
  requireThat(
    typeof record.test_status === "string" && TEST_STATUSES.has(record.test_status),
    "CLOUD_BROWSER_EVIDENCE_TEST_STATUS_INVALID",
  );
  requireThat(
    Array.isArray(record.results) &&
      record.results.length === CLOUD_BROWSER_EVIDENCE_JOURNEYS.length,
    "CLOUD_BROWSER_EVIDENCE_JOURNEYS_INVALID",
  );
  const results = CLOUD_BROWSER_EVIDENCE_JOURNEYS.map((journey, index) =>
    requireEvidenceResult(record.results[index], journey),
  );
  return Object.freeze({
    schema: CLOUD_BROWSER_EVIDENCE_SCHEMA,
    version: CLOUD_BROWSER_EVIDENCE_VERSION,
    run_id: runId,
    test_count: testCount,
    test_title: record.test_title,
    test_status: record.test_status,
    retries,
    results: Object.freeze(results),
  });
}

export function createCloudBrowserEvidence(source) {
  const record = asRecord(source, "CLOUD_BROWSER_EVIDENCE_SOURCE_INVALID");
  return requireCloudBrowserEvidence({
    schema: CLOUD_BROWSER_EVIDENCE_SCHEMA,
    version: CLOUD_BROWSER_EVIDENCE_VERSION,
    run_id: record.runId,
    test_count: record.testCount,
    test_title: record.testTitle,
    test_status: record.testStatus,
    retries: record.retries,
    results: record.results,
  });
}

export function parseCloudBrowserEvidence(text) {
  requireThat(typeof text === "string" && text.length > 0, "CLOUD_BROWSER_EVIDENCE_JSON_INVALID");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    requireThat(false, "CLOUD_BROWSER_EVIDENCE_JSON_INVALID");
  }
  return requireCloudBrowserEvidence(parsed);
}

export function assertCloudBrowserEvidencePassed(value) {
  const evidence = requireCloudBrowserEvidence(value);
  const statuses = new Map(evidence.results.map((entry) => [entry.journey, entry.status]));
  requireThat(
    evidence.test_count === 1 &&
      evidence.test_title === CLOUD_BROWSER_EXPECTED_TEST_TITLE &&
      evidence.test_status === "PASS" &&
      evidence.retries === 0 &&
      Object.entries(REQUIRED_RESULTS).every(
        ([journey, status]) => statuses.get(journey) === status,
      ),
    "CLOUD_BROWSER_EVIDENCE_NOT_PASSED",
  );
  return evidence;
}
