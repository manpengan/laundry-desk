import assert from "node:assert/strict";
import test from "node:test";

import {
  ADR36_API_EVIDENCE_JOURNEYS,
  ADR36_API_EVIDENCE_VERSION,
} from "./adr36-web-acceptance-evidence.mjs";
import { CLOUD_BROWSER_EXPECTED_TEST_TITLE } from "./cloud-web-browser-evidence.mjs";
import {
  FINALIZE_EVIDENCE_MAX_AGE_MS,
  canonicalFinalizeEvidence,
  createFinalizeEvidence,
  finalizeEvidenceDigest,
  parseCanonicalFinalizeEvidence,
  parseRetainedFinalizeEvidence,
  releaseTokenDigest,
  requireFinalizeEvidence,
  verificationEvidencePath,
} from "./hk-vps-release-finalize-evidence.mjs";

const CANDIDATE = "a".repeat(40);
const EXPECTED = "b".repeat(40);
const MIGRATION = "0046_cloud_primary.sql";
const TOKEN = "c".repeat(32);
const NOW = new Date("2026-08-10T02:30:00.000Z");
const UUID = "12345678-1234-4123-8123-123456789abc";
const LEGACY_API_JOURNEYS = Object.freeze([
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

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export function passedApiEvidence() {
  return Object.freeze({
    schema: "laundry.adr36.api-acceptance-evidence",
    version: ADR36_API_EVIDENCE_VERSION,
    run_id: "ADR36-20260810T022900Z-12345678",
    results: Object.freeze(
      ADR36_API_EVIDENCE_JOURNEYS.map((journey) => Object.freeze({ journey, status: "PASS" })),
    ),
  });
}

export function passedBrowserEvidence() {
  return Object.freeze({
    schema: "laundry.cloud-web.browser-evidence",
    version: 1,
    run_id: "CLOUD-BROWSER-20260810T022930Z-12345678",
    test_count: 1,
    test_title: CLOUD_BROWSER_EXPECTED_TEST_TITLE,
    test_status: "PASS",
    retries: 0,
    results: Object.freeze([
      Object.freeze({ journey: "configuration", status: "PASS" }),
      Object.freeze({ journey: "core_ui_subset", status: "PASS" }),
      Object.freeze({ journey: "session_logout", status: "PASS" }),
      Object.freeze({ journey: "business_cleanup", status: "NOT_REQUIRED" }),
      Object.freeze({ journey: "standalone_completion", status: "NOT_AUTHORIZED" }),
    ]),
  });
}

export function evidenceInput(overrides = {}) {
  return Object.freeze({
    api: passedApiEvidence(),
    browser: passedBrowserEvidence(),
    candidateSha: CANDIDATE,
    expectedSha: EXPECTED,
    migrationHead: MIGRATION,
    token: TOKEN,
    ...overrides,
  });
}

function legacyRetainedEvidence(overrides = {}) {
  return Object.freeze({
    schema: "laundry.cloud-release.finalize-evidence",
    version: 1,
    candidate_sha: CANDIDATE,
    expected_sha: EXPECTED,
    migration_head: MIGRATION,
    token_sha256: releaseTokenDigest(TOKEN),
    verification_id: UUID,
    api: Object.freeze({
      schema: "laundry.adr36.api-acceptance-evidence",
      version: 1,
      run_id: "ADR36-20260810T022900Z-12345678",
      results: Object.freeze(
        LEGACY_API_JOURNEYS.map((journey) => Object.freeze({ journey, status: "PASS" })),
      ),
    }),
    browser: passedBrowserEvidence(),
    created_at: NOW.toISOString(),
    ...overrides,
  });
}

test("finalize evidence binds both machine proofs to the exact release identity", () => {
  const evidence = createFinalizeEvidence(evidenceInput(), {
    now: () => NOW,
    randomUUID: () => UUID,
  });
  assert.deepEqual(Object.keys(evidence), [
    "schema",
    "version",
    "candidate_sha",
    "expected_sha",
    "migration_head",
    "token_sha256",
    "verification_id",
    "api",
    "browser",
    "created_at",
  ]);
  assert.equal(evidence.token_sha256, releaseTokenDigest(TOKEN));
  assert.equal(evidence.verification_id, UUID);
  assert.equal(evidence.created_at, NOW.toISOString());
  assert.doesNotMatch(JSON.stringify(evidence), new RegExp(TOKEN, "u"));
  assert.equal(
    verificationEvidencePath(CANDIDATE, evidence.token_sha256),
    `/var/lib/laundry-desk-release/verification-${CANDIDATE}-${evidence.token_sha256}.json`,
  );

  const canonical = canonicalFinalizeEvidence(evidence, evidenceInput(), NOW);
  assert.equal(canonical, canonicalFinalizeEvidence(evidence, evidenceInput(), NOW));
  assert.deepEqual(parseCanonicalFinalizeEvidence(canonical, evidenceInput(), NOW), evidence);
  assert.match(finalizeEvidenceDigest(evidence, evidenceInput(), NOW), /^[0-9a-f]{64}$/u);
  assert.equal(canonical.startsWith('{"api":'), true);
});

test("finalize evidence rejects schema drift, identity drift and incomplete nested runs", () => {
  const evidence = createFinalizeEvidence(evidenceInput(), {
    now: () => NOW,
    randomUUID: () => UUID,
  });
  const failedApi = {
    ...evidence.api,
    results: evidence.api.results.map((entry) =>
      entry.journey === "overall"
        ? { journey: entry.journey, status: "FAIL", code: "ACCEPTANCE_FAILED" }
        : entry,
    ),
  };
  for (const invalid of [
    { ...evidence, extra: true },
    { ...evidence, schema: "wrong" },
    { ...evidence, candidate_sha: EXPECTED },
    { ...evidence, token_sha256: "0".repeat(64) },
    { ...evidence, verification_id: "not-a-uuid" },
    { ...evidence, api: failedApi },
    { ...evidence, browser: { ...evidence.browser, retries: 1 } },
  ]) {
    assert.throws(() => requireFinalizeEvidence(invalid, evidenceInput(), NOW));
  }
});

test("finalize evidence freshness allows only the bounded canonical window", () => {
  const base = createFinalizeEvidence(evidenceInput(), {
    now: () => NOW,
    randomUUID: () => UUID,
  });
  const canonical = canonicalFinalizeEvidence(base, evidenceInput(), NOW);
  assert.doesNotThrow(() =>
    parseCanonicalFinalizeEvidence(
      canonical,
      evidenceInput(),
      new Date(NOW.getTime() + FINALIZE_EVIDENCE_MAX_AGE_MS),
    ),
  );
  assert.throws(
    () =>
      parseCanonicalFinalizeEvidence(
        canonical,
        evidenceInput(),
        new Date(NOW.getTime() + FINALIZE_EVIDENCE_MAX_AGE_MS + 1),
      ),
    { code: "CLOUD_RELEASE_EVIDENCE_STALE" },
  );
  assert.throws(
    () =>
      parseCanonicalFinalizeEvidence(canonical, evidenceInput(), new Date(NOW.getTime() - 60_001)),
    { code: "CLOUD_RELEASE_EVIDENCE_STALE" },
  );
});

test("retained evidence accepts the exact committed v1 profile without weakening finalize", () => {
  const legacy = legacyRetainedEvidence();
  const canonical = canonicalJson(legacy);
  assert.deepEqual(parseRetainedFinalizeEvidence(canonical, evidenceInput()), legacy);
  assert.throws(() => parseCanonicalFinalizeEvidence(canonical, evidenceInput(), NOW), {
    code: "CLOUD_RELEASE_EVIDENCE_NOT_PASSED",
  });

  const current = createFinalizeEvidence(evidenceInput(), {
    now: () => NOW,
    randomUUID: () => UUID,
  });
  const currentCanonical = canonicalFinalizeEvidence(current, evidenceInput(), NOW);
  assert.deepEqual(parseRetainedFinalizeEvidence(currentCanonical, evidenceInput()), current);
});

test("retained evidence rejects drift from the exact committed v1 profile", () => {
  const legacy = legacyRetainedEvidence();
  const failedResults = legacy.api.results.map((entry) =>
    entry.journey === "overall"
      ? { journey: entry.journey, status: "FAIL", code: "ACCEPTANCE_FAILED" }
      : entry,
  );
  const reversedResults = [...legacy.api.results].reverse();
  for (const invalid of [
    { ...legacy, api: { ...legacy.api, version: 2 } },
    { ...legacy, api: { ...legacy.api, extra: true } },
    { ...legacy, api: { ...legacy.api, results: legacy.api.results.slice(0, -1) } },
    { ...legacy, api: { ...legacy.api, results: reversedResults } },
    { ...legacy, api: { ...legacy.api, results: failedResults } },
    { ...legacy, browser: { ...legacy.browser, version: 2 } },
    { ...legacy, browser: { ...legacy.browser, retries: 1 } },
  ]) {
    assert.throws(() => parseRetainedFinalizeEvidence(canonicalJson(invalid), evidenceInput()), {
      code: "CLOUD_RELEASE_EVIDENCE_NOT_PASSED",
    });
  }
});

test("remote input accepts canonical JSON only, without trailing text or whitespace", () => {
  const evidence = createFinalizeEvidence(evidenceInput(), {
    now: () => NOW,
    randomUUID: () => UUID,
  });
  const canonical = canonicalFinalizeEvidence(evidence, evidenceInput(), NOW);
  for (const invalid of [
    `${canonical}\n`,
    ` ${canonical}`,
    JSON.stringify(evidence),
    `${canonical}private`,
    "",
  ]) {
    assert.throws(() => parseCanonicalFinalizeEvidence(invalid, evidenceInput(), NOW));
  }
});
