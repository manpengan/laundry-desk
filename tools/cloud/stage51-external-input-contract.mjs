import { fail, requireSha } from "./hk-vps-release-identifiers.mjs";

export const STAGE51_EXTERNAL_INPUT_SCHEMA = "laundry.stage51.external-input-register";
export const STAGE51_EXTERNAL_INPUT_VERSION = 1;
export const STAGE51_EXTERNAL_INPUT_MAX_BYTES = 32 * 1024;
export const STAGE51_EXTERNAL_INPUT_READY_STATE = "input_authorized";

const REGISTER_ERROR = "CLOUD_STAGE51_EXTERNAL_INPUT_REGISTER_INVALID";
const JSON_ERROR = "CLOUD_STAGE51_EXTERNAL_INPUT_JSON_INVALID";
const REFERENCE = /^(asset|document|owner|ticket):([A-Za-z0-9][A-Za-z0-9._/-]{2,191})$/u;
const SENSITIVE_REFERENCE =
  /(?:password|passwd|secret|token|credential|private[-_]?key|database[-_]?url)/iu;

const INPUT_DEFINITIONS = Object.freeze([
  Object.freeze({
    blocker: "blocked_external_environment",
    key: "environment",
    references: Object.freeze([
      Object.freeze({ key: "authorization_ref", kinds: Object.freeze(["document", "ticket"]) }),
      Object.freeze({ key: "candidate_identity_ref", kinds: Object.freeze(["asset", "document"]) }),
      Object.freeze({ key: "dns_tls_identity_ref", kinds: Object.freeze(["asset", "document"]) }),
      Object.freeze({ key: "owner_ref", kinds: Object.freeze(["owner"]) }),
    ]),
  }),
  Object.freeze({
    blocker: "blocked_external_offsite",
    key: "offsite",
    references: Object.freeze([
      Object.freeze({ key: "authorization_ref", kinds: Object.freeze(["document", "ticket"]) }),
      Object.freeze({
        key: "encryption_evidence_ref",
        kinds: Object.freeze(["document", "ticket"]),
      }),
      Object.freeze({ key: "failure_domain_ref", kinds: Object.freeze(["asset", "document"]) }),
      Object.freeze({ key: "owner_ref", kinds: Object.freeze(["owner"]) }),
      Object.freeze({ key: "target_identity_ref", kinds: Object.freeze(["asset", "document"]) }),
    ]),
  }),
  Object.freeze({
    blocker: "blocked_external_alerting",
    key: "alerting",
    references: Object.freeze([
      Object.freeze({ key: "authorization_ref", kinds: Object.freeze(["document", "ticket"]) }),
      Object.freeze({ key: "clear_contract_ref", kinds: Object.freeze(["document", "ticket"]) }),
      Object.freeze({ key: "owner_ref", kinds: Object.freeze(["owner"]) }),
      Object.freeze({ key: "receipt_contract_ref", kinds: Object.freeze(["document", "ticket"]) }),
      Object.freeze({ key: "receiver_identity_ref", kinds: Object.freeze(["asset", "document"]) }),
    ]),
  }),
  Object.freeze({
    blocker: "blocked_external_capacity",
    key: "capacity",
    references: Object.freeze([
      Object.freeze({ key: "approval_ref", kinds: Object.freeze(["document", "ticket"]) }),
      Object.freeze({ key: "owner_ref", kinds: Object.freeze(["owner"]) }),
      Object.freeze({ key: "profile_ref", kinds: Object.freeze(["document"]) }),
      Object.freeze({ key: "thresholds_ref", kinds: Object.freeze(["document"]) }),
    ]),
  }),
]);

export const STAGE51_EXTERNAL_BLOCKERS = Object.freeze(
  INPUT_DEFINITIONS.map(({ blocker }) => blocker),
);

function exactKeys(value, expected) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function requireTimestamp(value) {
  if (typeof value !== "string") fail(REGISTER_ERROR);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    fail(REGISTER_ERROR);
  }
  return value;
}

function requireReference(value, kinds) {
  if (value === null) return null;
  if (typeof value !== "string" || SENSITIVE_REFERENCE.test(value)) fail(REGISTER_ERROR);
  const match = REFERENCE.exec(value);
  if (
    match === null ||
    !kinds.includes(match[1]) ||
    match[2].includes("..") ||
    match[2].includes("//") ||
    match[2].endsWith("/")
  ) {
    fail(REGISTER_ERROR);
  }
  return value;
}

function requireInput(value, definition) {
  const referenceKeys = definition.references.map(({ key }) => key);
  if (!exactKeys(value, ["state", ...referenceKeys])) fail(REGISTER_ERROR);
  const references = Object.fromEntries(
    definition.references.map(({ key, kinds }) => [key, requireReference(value[key], kinds)]),
  );
  if (
    ![definition.blocker, STAGE51_EXTERNAL_INPUT_READY_STATE].includes(value.state) ||
    (value.state === definition.blocker &&
      Object.values(references).some((item) => item !== null)) ||
    (value.state === STAGE51_EXTERNAL_INPUT_READY_STATE &&
      Object.values(references).some((item) => item === null))
  ) {
    fail(REGISTER_ERROR);
  }
  return Object.freeze({ state: value.state, ...references });
}

function requireBinding(binding) {
  if (exactKeys(binding, [])) return undefined;
  if (!exactKeys(binding, ["mainSha"])) fail(REGISTER_ERROR);
  return requireSha(binding.mainSha, REGISTER_ERROR);
}

export function requireStage51ExternalInputRegister(value, binding = {}) {
  if (
    !exactKeys(value, ["assessed_at", "inputs", "main_sha", "schema", "version"]) ||
    value.schema !== STAGE51_EXTERNAL_INPUT_SCHEMA ||
    value.version !== STAGE51_EXTERNAL_INPUT_VERSION ||
    !exactKeys(
      value.inputs,
      INPUT_DEFINITIONS.map(({ key }) => key),
    )
  ) {
    fail(REGISTER_ERROR);
  }
  const inputs = Object.freeze(
    Object.fromEntries(
      INPUT_DEFINITIONS.map((definition) => [
        definition.key,
        requireInput(value.inputs[definition.key], definition),
      ]),
    ),
  );
  const mainSha = requireSha(value.main_sha, REGISTER_ERROR);
  const expectedMainSha = requireBinding(binding);
  if (expectedMainSha !== undefined && mainSha !== expectedMainSha) fail(REGISTER_ERROR);
  return Object.freeze({
    assessed_at: requireTimestamp(value.assessed_at),
    inputs,
    main_sha: mainSha,
    schema: STAGE51_EXTERNAL_INPUT_SCHEMA,
    version: STAGE51_EXTERNAL_INPUT_VERSION,
  });
}

function canonicalValue(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (typeof value !== "object" || value === null) fail(REGISTER_ERROR);
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`)
    .join(",")}}`;
}

export function canonicalStage51ExternalInputRegister(value, binding = {}) {
  return `${canonicalValue(requireStage51ExternalInputRegister(value, binding))}\n`;
}

export function parseStage51ExternalInputRegister(text, binding = {}) {
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    Buffer.byteLength(text, "utf8") > STAGE51_EXTERNAL_INPUT_MAX_BYTES
  ) {
    fail(JSON_ERROR);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    // JSON.parse errors can contain source text; evidence errors must not retain it.
    fail(JSON_ERROR);
  }
  const register = requireStage51ExternalInputRegister(value, binding);
  if (text !== `${canonicalValue(register)}\n`) {
    fail("CLOUD_STAGE51_EXTERNAL_INPUT_NOT_CANONICAL");
  }
  return register;
}

export function summarizeStage51ExternalInputRegister(value, binding = {}) {
  const register = requireStage51ExternalInputRegister(value, binding);
  const blockers = Object.freeze(
    INPUT_DEFINITIONS.filter(
      ({ key }) => register.inputs[key].state !== STAGE51_EXTERNAL_INPUT_READY_STATE,
    ).map(({ blocker }) => blocker),
  );
  return Object.freeze({
    blockers,
    ready_for_profile_registration: blockers.length === 0,
  });
}

export function createBlockedStage51ExternalInputRegister(mainSha, assessedAt) {
  return requireStage51ExternalInputRegister({
    assessed_at: assessedAt,
    inputs: Object.fromEntries(
      INPUT_DEFINITIONS.map((definition) => [
        definition.key,
        {
          state: definition.blocker,
          ...Object.fromEntries(definition.references.map(({ key }) => [key, null])),
        },
      ]),
    ),
    main_sha: mainSha,
    schema: STAGE51_EXTERNAL_INPUT_SCHEMA,
    version: STAGE51_EXTERNAL_INPUT_VERSION,
  });
}
