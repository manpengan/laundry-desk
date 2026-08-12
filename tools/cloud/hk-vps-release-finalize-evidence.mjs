import { createHash, randomUUID as systemRandomUUID } from "node:crypto";

import {
  assertAdr36ApiAcceptancePassed,
  requireAdr36ApiAcceptanceEvidence,
} from "./adr36-web-acceptance-evidence.mjs";
import {
  assertCloudBrowserEvidencePassed,
  requireCloudBrowserEvidence,
} from "./cloud-web-browser-evidence.mjs";
import { fail, requireMigrationHead, requireSha, requireToken } from "./hk-vps-release-core.mjs";
import {
  isLegacyFinalizeEvidenceProfile,
  requireLegacyFinalizeEvidencePassed,
} from "./hk-vps-release-finalize-evidence-compat.mjs";

export const FINALIZE_EVIDENCE_SCHEMA = "laundry.cloud-release.finalize-evidence";
export const FINALIZE_EVIDENCE_VERSION = 1;
export const FINALIZE_EVIDENCE_MAX_AGE_MS = 30 * 60_000;
export const FINALIZE_EVIDENCE_MAX_FUTURE_MS = 60_000;
export const FINALIZE_EVIDENCE_MAX_BYTES = 64 * 1024;
export const FINALIZE_EVIDENCE_ROOT = "/var/lib/laundry-desk-release";

const DIGEST = /^[0-9a-f]{64}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const OUTER_KEYS = Object.freeze([
  "api",
  "browser",
  "candidate_sha",
  "created_at",
  "expected_sha",
  "migration_head",
  "schema",
  "token_sha256",
  "verification_id",
  "version",
]);

function exactKeys(value, keys) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function validNow(now) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    fail("CLOUD_RELEASE_EVIDENCE_CLOCK_INVALID");
  }
  return now;
}

function requireCreatedAt(value, now) {
  if (typeof value !== "string") fail("CLOUD_RELEASE_EVIDENCE_TIME_INVALID");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    fail("CLOUD_RELEASE_EVIDENCE_TIME_INVALID");
  }
  const age = validNow(now).getTime() - timestamp;
  if (age < -FINALIZE_EVIDENCE_MAX_FUTURE_MS || age > FINALIZE_EVIDENCE_MAX_AGE_MS) {
    fail("CLOUD_RELEASE_EVIDENCE_STALE");
  }
  return value;
}

function requireNestedEvidence(api, browser, allowLegacy = false) {
  try {
    if (allowLegacy && isLegacyFinalizeEvidenceProfile(api, browser)) {
      return requireLegacyFinalizeEvidencePassed(api, browser);
    }
    return Object.freeze({
      api: assertAdr36ApiAcceptancePassed(requireAdr36ApiAcceptanceEvidence(api)),
      browser: assertCloudBrowserEvidencePassed(requireCloudBrowserEvidence(browser)),
    });
  } catch (error) {
    fail("CLOUD_RELEASE_EVIDENCE_NOT_PASSED", error);
  }
}

export function releaseTokenDigest(token) {
  return createHash("sha256").update(requireToken(token), "utf8").digest("hex");
}

export function verificationEvidencePath(candidateSha, tokenSha256) {
  const candidate = requireSha(candidateSha, "CLOUD_RELEASE_EVIDENCE_PATH_INVALID");
  if (typeof tokenSha256 !== "string" || !DIGEST.test(tokenSha256)) {
    fail("CLOUD_RELEASE_EVIDENCE_PATH_INVALID");
  }
  return `${FINALIZE_EVIDENCE_ROOT}/verification-${candidate}-${tokenSha256}.json`;
}

export function isTransitionEvidenceStateValid(record) {
  const hasEvidence =
    record.verification_evidence_path !== null && record.verification_evidence_sha256 !== null;
  if (
    [record.verification_evidence_path, record.verification_evidence_sha256].some(
      (item) => (item === null) !== !hasEvidence,
    ) ||
    (hasEvidence &&
      (record.verification_evidence_path !==
        verificationEvidencePath(record.candidate_sha, releaseTokenDigest(record.token)) ||
        !DIGEST.test(record.verification_evidence_sha256)))
  ) {
    return false;
  }
  if (record.outcome === "committed") {
    return (
      hasEvidence &&
      record.phase === "awaiting_external_verification" &&
      record.verification_evidence_authoritative === true
    );
  }
  if (record.outcome === "rolled_back") {
    return (
      record.verification_evidence_authoritative === false &&
      (!hasEvidence ||
        ["awaiting_external_verification", "recovery_required"].includes(record.phase))
    );
  }
  if (record.outcome !== null) return false;
  if (!hasEvidence) return record.verification_evidence_authoritative === null;
  return (
    (record.phase === "awaiting_external_verification" &&
      record.verification_evidence_authoritative === true) ||
    (record.phase === "recovery_required" && record.verification_evidence_authoritative === false)
  );
}

function requireFinalizeEvidenceWithProfile(value, binding, now, allowLegacyNestedEvidence) {
  if (!exactKeys(value, OUTER_KEYS)) fail("CLOUD_RELEASE_EVIDENCE_INVALID");
  if (value.schema !== FINALIZE_EVIDENCE_SCHEMA || value.version !== FINALIZE_EVIDENCE_VERSION) {
    fail("CLOUD_RELEASE_EVIDENCE_SCHEMA_INVALID");
  }
  const candidateSha = requireSha(value.candidate_sha, "CLOUD_RELEASE_EVIDENCE_INVALID");
  const expectedSha = requireSha(value.expected_sha, "CLOUD_RELEASE_EVIDENCE_INVALID");
  const migrationHead = requireMigrationHead(value.migration_head);
  if (typeof value.token_sha256 !== "string" || !DIGEST.test(value.token_sha256)) {
    fail("CLOUD_RELEASE_EVIDENCE_TOKEN_DIGEST_INVALID");
  }
  if (typeof value.verification_id !== "string" || !UUID_V4.test(value.verification_id)) {
    fail("CLOUD_RELEASE_EVIDENCE_ID_INVALID");
  }
  const createdAt = requireCreatedAt(value.created_at, now);
  const nested = requireNestedEvidence(value.api, value.browser, allowLegacyNestedEvidence);
  if (
    (binding.candidateSha !== undefined && candidateSha !== binding.candidateSha) ||
    (binding.expectedSha !== undefined && expectedSha !== binding.expectedSha) ||
    (binding.migrationHead !== undefined && migrationHead !== binding.migrationHead) ||
    (binding.token !== undefined && value.token_sha256 !== releaseTokenDigest(binding.token))
  ) {
    fail("CLOUD_RELEASE_EVIDENCE_IDENTITY_MISMATCH");
  }
  return Object.freeze({
    schema: FINALIZE_EVIDENCE_SCHEMA,
    version: FINALIZE_EVIDENCE_VERSION,
    candidate_sha: candidateSha,
    expected_sha: expectedSha,
    migration_head: migrationHead,
    token_sha256: value.token_sha256,
    verification_id: value.verification_id,
    api: nested.api,
    browser: nested.browser,
    created_at: createdAt,
  });
}

export function requireFinalizeEvidence(value, binding = {}, now = new Date()) {
  return requireFinalizeEvidenceWithProfile(value, binding, now, false);
}

export function createFinalizeEvidence(input, options = {}) {
  const now = validNow(options.now?.() ?? new Date());
  const randomUUID = options.randomUUID ?? systemRandomUUID;
  const token = requireToken(input.token);
  return requireFinalizeEvidence(
    {
      schema: FINALIZE_EVIDENCE_SCHEMA,
      version: FINALIZE_EVIDENCE_VERSION,
      candidate_sha: input.candidateSha,
      expected_sha: input.expectedSha,
      migration_head: input.migrationHead,
      token_sha256: releaseTokenDigest(token),
      verification_id: randomUUID(),
      api: input.api,
      browser: input.browser,
      created_at: now.toISOString(),
    },
    input,
    now,
  );
}

function canonicalValue(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail("CLOUD_RELEASE_EVIDENCE_CANONICAL_INVALID");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value !== "object" || value === null) {
    fail("CLOUD_RELEASE_EVIDENCE_CANONICAL_INVALID");
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`)
    .join(",")}}`;
}

export function canonicalFinalizeEvidence(value, binding = {}, now = new Date()) {
  return canonicalValue(requireFinalizeEvidence(value, binding, now));
}

export function finalizeEvidenceDigest(value, binding = {}, now = new Date()) {
  return createHash("sha256")
    .update(canonicalFinalizeEvidence(value, binding, now), "utf8")
    .digest("hex");
}

function parseCanonicalFinalizeEvidenceWithProfile(text, binding, now, allowLegacyNestedEvidence) {
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    Buffer.byteLength(text, "utf8") > FINALIZE_EVIDENCE_MAX_BYTES
  ) {
    fail("CLOUD_RELEASE_EVIDENCE_JSON_INVALID");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail("CLOUD_RELEASE_EVIDENCE_JSON_INVALID", error);
  }
  const evidence = requireFinalizeEvidenceWithProfile(
    parsed,
    binding,
    now,
    allowLegacyNestedEvidence,
  );
  if (text !== canonicalValue(evidence)) fail("CLOUD_RELEASE_EVIDENCE_NOT_CANONICAL");
  return evidence;
}

export function parseCanonicalFinalizeEvidence(text, binding = {}, now = new Date()) {
  return parseCanonicalFinalizeEvidenceWithProfile(text, binding, now, false);
}

export function parseRetainedFinalizeEvidence(text, binding = {}) {
  let createdAt;
  try {
    createdAt = JSON.parse(text)?.created_at;
  } catch (error) {
    fail("CLOUD_RELEASE_EVIDENCE_JSON_INVALID", error);
  }
  return parseCanonicalFinalizeEvidenceWithProfile(text, binding, new Date(createdAt), true);
}

export function parseSingleJsonLine(text, maximumBytes, code) {
  if (
    typeof text !== "string" ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    Buffer.byteLength(text, "utf8") > maximumBytes ||
    text.includes("\r")
  ) {
    fail(code);
  }
  const line = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (line.length === 0 || line.includes("\n")) fail(code);
  return line;
}
