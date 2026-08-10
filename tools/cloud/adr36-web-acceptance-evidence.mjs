import { asRecord, requireString, requireThat } from "./adr36-web-core.mjs";

export const ADR36_API_EVIDENCE_SCHEMA = "laundry.adr36.api-acceptance-evidence";
export const ADR36_API_EVIDENCE_VERSION = 1;

export const ADR36_API_EVIDENCE_JOURNEYS = Object.freeze([
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

const TOP_LEVEL_KEYS = Object.freeze(["results", "run_id", "schema", "version"]);
const RESULT_KEYS = Object.freeze(["journey", "status"]);
const RESULT_KEYS_WITH_CODE = Object.freeze(["code", ...RESULT_KEYS]);
const RUN_ID = /^ADR36-\d{8}T\d{6}(?:\d{3})?Z-[0-9a-f]{8}$/u;
const STATUSES = new Set(["BLOCKED", "FAIL", "PASS"]);
const EVIDENCE_CODES = new Set([
  "ACCEPTANCE_FAILED",
  "AUDITED_TIME_FIXTURE_REQUIRED",
  "CLEANUP_INCOMPLETE",
  "DEPENDENCY_FAILED",
  "LOGOUT_INCOMPLETE",
  "PARTIAL_ACCEPTANCE_ONLY",
]);
function hasExactKeys(record, expected) {
  const actual = Object.keys(record).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeEvidenceCode(status, code) {
  if (status === "PASS") return undefined;
  return typeof code === "string" && EVIDENCE_CODES.has(code) ? code : "ACCEPTANCE_FAILED";
}

function requireEvidenceResult(value, expectedJourney) {
  const entry = asRecord(value, "ADR36_API_EVIDENCE_RESULT_INVALID");
  const expectedKeys = entry.code === undefined ? RESULT_KEYS : RESULT_KEYS_WITH_CODE;
  requireThat(hasExactKeys(entry, expectedKeys), "ADR36_API_EVIDENCE_RESULT_INVALID");
  requireThat(entry.journey === expectedJourney, "ADR36_API_EVIDENCE_JOURNEYS_INVALID");
  requireThat(
    typeof entry.status === "string" && STATUSES.has(entry.status),
    "ADR36_API_EVIDENCE_STATUS_INVALID",
  );
  if (entry.status === "PASS") {
    requireThat(entry.code === undefined, "ADR36_API_EVIDENCE_CODE_INVALID");
  } else {
    requireThat(
      typeof entry.code === "string" && EVIDENCE_CODES.has(entry.code),
      "ADR36_API_EVIDENCE_CODE_INVALID",
    );
  }
  return Object.freeze({
    journey: expectedJourney,
    status: entry.status,
    ...(entry.code === undefined ? {} : { code: entry.code }),
  });
}

export function requireAdr36ApiAcceptanceEvidence(value) {
  const record = asRecord(value, "ADR36_API_EVIDENCE_INVALID");
  requireThat(hasExactKeys(record, TOP_LEVEL_KEYS), "ADR36_API_EVIDENCE_INVALID");
  requireThat(record.schema === ADR36_API_EVIDENCE_SCHEMA, "ADR36_API_EVIDENCE_SCHEMA_INVALID");
  requireThat(record.version === ADR36_API_EVIDENCE_VERSION, "ADR36_API_EVIDENCE_VERSION_INVALID");
  requireThat(
    typeof record.run_id === "string" && RUN_ID.test(record.run_id),
    "ADR36_API_EVIDENCE_RUN_ID_INVALID",
  );
  requireThat(
    Array.isArray(record.results) && record.results.length === ADR36_API_EVIDENCE_JOURNEYS.length,
    "ADR36_API_EVIDENCE_JOURNEYS_INVALID",
  );
  const results = ADR36_API_EVIDENCE_JOURNEYS.map((journey, index) =>
    requireEvidenceResult(record.results[index], journey),
  );
  return Object.freeze({
    schema: ADR36_API_EVIDENCE_SCHEMA,
    version: ADR36_API_EVIDENCE_VERSION,
    run_id: record.run_id,
    results: Object.freeze(results),
  });
}

export function createAdr36ApiAcceptanceEvidence(report) {
  const record = asRecord(report, "ADR36_API_REPORT_INVALID");
  requireThat(
    typeof record.runId === "string" && RUN_ID.test(record.runId),
    "ADR36_API_EVIDENCE_RUN_ID_INVALID",
  );
  requireThat(Array.isArray(record.results), "ADR36_API_REPORT_INVALID");
  const source = new Map();
  for (const value of record.results) {
    const entry = asRecord(value, "ADR36_API_REPORT_INVALID");
    const journey = requireString(entry.journey, "ADR36_API_REPORT_INVALID");
    requireThat(
      ADR36_API_EVIDENCE_JOURNEYS.includes(journey) && !source.has(journey),
      "ADR36_API_REPORT_INVALID",
    );
    requireThat(
      typeof entry.status === "string" && STATUSES.has(entry.status),
      "ADR36_API_REPORT_INVALID",
    );
    source.set(journey, entry);
  }
  const results = ADR36_API_EVIDENCE_JOURNEYS.map((journey) => {
    const entry = source.get(journey);
    requireThat(entry !== undefined, "ADR36_API_REPORT_INVALID");
    const code = safeEvidenceCode(entry.status, entry.code);
    return Object.freeze({
      journey,
      status: entry.status,
      ...(code === undefined ? {} : { code }),
    });
  });
  return requireAdr36ApiAcceptanceEvidence({
    schema: ADR36_API_EVIDENCE_SCHEMA,
    version: ADR36_API_EVIDENCE_VERSION,
    run_id: record.runId,
    results,
  });
}

export function parseAdr36ApiAcceptanceEvidence(text) {
  requireThat(typeof text === "string" && text.length > 0, "ADR36_API_EVIDENCE_JSON_INVALID");
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    requireThat(false, "ADR36_API_EVIDENCE_JSON_INVALID");
  }
  return requireAdr36ApiAcceptanceEvidence(parsed);
}

export function assertAdr36ApiAcceptancePassed(value) {
  const evidence = requireAdr36ApiAcceptanceEvidence(value);
  requireThat(
    evidence.results.every((entry) => entry.status === "PASS"),
    "ADR36_API_EVIDENCE_NOT_PASSED",
  );
  return evidence;
}
