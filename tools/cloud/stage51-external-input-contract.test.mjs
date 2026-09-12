import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  STAGE51_EXTERNAL_BLOCKERS,
  STAGE51_EXTERNAL_INPUT_MAX_BYTES,
  STAGE51_EXTERNAL_INPUT_READY_STATE,
  STAGE51_EXTERNAL_INPUT_SCHEMA,
  STAGE51_EXTERNAL_INPUT_VERSION,
  canonicalStage51ExternalInputRegister,
  createBlockedStage51ExternalInputRegister,
  parseStage51ExternalInputRegister,
  requireStage51ExternalInputRegister,
  summarizeStage51ExternalInputRegister,
} from "./stage51-external-input-contract.mjs";

const MAIN_SHA = "29d02aaf8fbce32f2b4d9ccb02bb062128c583e9";
const ASSESSED_AT = "2026-08-28T09:50:10.000Z";
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CURRENT_REGISTER = join(
  ROOT,
  "docs/operations/2026-08-28-stage51-external-input-register.json",
);

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function blockedRegister() {
  return createBlockedStage51ExternalInputRegister(MAIN_SHA, ASSESSED_AT);
}

function authorizedRegister() {
  return {
    assessed_at: ASSESSED_AT,
    inputs: {
      environment: {
        state: STAGE51_EXTERNAL_INPUT_READY_STATE,
        authorization_ref: "ticket:OPS-5101",
        candidate_identity_ref: "asset:production-candidate-01",
        dns_tls_identity_ref: "document:stage51/environment-dns-tls-v1",
        owner_ref: "owner:platform-operator",
      },
      offsite: {
        state: STAGE51_EXTERNAL_INPUT_READY_STATE,
        authorization_ref: "ticket:OPS-5102",
        encryption_evidence_ref: "document:stage51/offsite-encryption-v1",
        failure_domain_ref: "asset:offsite-failure-domain-01",
        owner_ref: "owner:backup-operator",
        target_identity_ref: "asset:offsite-target-01",
      },
      alerting: {
        state: STAGE51_EXTERNAL_INPUT_READY_STATE,
        authorization_ref: "ticket:OPS-5103",
        clear_contract_ref: "document:stage51/alert-clear-contract-v1",
        owner_ref: "owner:alert-operator",
        receipt_contract_ref: "document:stage51/alert-receipt-contract-v1",
        receiver_identity_ref: "asset:alert-receiver-01",
      },
      capacity: {
        state: STAGE51_EXTERNAL_INPUT_READY_STATE,
        approval_ref: "ticket:PRODUCT-5104",
        owner_ref: "owner:product-owner",
        profile_ref: "document:stage51/single-store-capacity-v1",
        thresholds_ref: "document:stage51/api-ui-thresholds-v1",
      },
    },
    main_sha: MAIN_SHA,
    schema: STAGE51_EXTERNAL_INPUT_SCHEMA,
    version: STAGE51_EXTERNAL_INPUT_VERSION,
  };
}

test("blocked register is canonical, deeply frozen, and preserves all exact external blockers", () => {
  const register = blockedRegister();
  const canonical = canonicalStage51ExternalInputRegister(register);
  assert.deepEqual(parseStage51ExternalInputRegister(canonical), register);
  assert.deepEqual(summarizeStage51ExternalInputRegister(register), {
    blockers: STAGE51_EXTERNAL_BLOCKERS,
    ready_for_profile_registration: false,
  });
  assert.equal(Object.isFrozen(register), true);
  assert.equal(Object.isFrozen(register.inputs), true);
  assert.equal(Object.isFrozen(register.inputs.environment), true);
  assert.equal(Object.isFrozen(STAGE51_EXTERNAL_BLOCKERS), true);
});

test("only a complete non-secret input register becomes ready for profile registration", () => {
  const register = requireStage51ExternalInputRegister(authorizedRegister());
  assert.deepEqual(summarizeStage51ExternalInputRegister(register), {
    blockers: [],
    ready_for_profile_registration: true,
  });
  assert.deepEqual(Object.keys(summarizeStage51ExternalInputRegister(register)).sort(), [
    "blockers",
    "ready_for_profile_registration",
  ]);
  assert.equal("ready_for_host_mutation" in summarizeStage51ExternalInputRegister(register), false);
});

test("partial authorization retains only the corresponding external blockers", () => {
  const value = authorizedRegister();
  value.inputs.offsite = blockedRegister().inputs.offsite;
  value.inputs.capacity = blockedRegister().inputs.capacity;
  assert.deepEqual(summarizeStage51ExternalInputRegister(value), {
    blockers: ["blocked_external_offsite", "blocked_external_capacity"],
    ready_for_profile_registration: false,
  });
});

test("register rejects schema, identity, timestamp, key, and input-set drift", () => {
  const cases = [];
  const extraRoot = copy(blockedRegister());
  extraRoot.note = "not allowed";
  cases.push(extraRoot);
  const wrongSchema = copy(blockedRegister());
  wrongSchema.schema = "laundry.stage51.external-input-register-v2";
  cases.push(wrongSchema);
  const wrongVersion = copy(blockedRegister());
  wrongVersion.version = 2;
  cases.push(wrongVersion);
  const wrongSha = copy(blockedRegister());
  wrongSha.main_sha = MAIN_SHA.toUpperCase();
  cases.push(wrongSha);
  const wrongTime = copy(blockedRegister());
  wrongTime.assessed_at = "2026-08-28T09:50:10Z";
  cases.push(wrongTime);
  const missingInput = copy(blockedRegister());
  delete missingInput.inputs.alerting;
  cases.push(missingInput);
  const extraInput = copy(blockedRegister());
  extraInput.inputs.recovery = {};
  cases.push(extraInput);
  for (const value of cases) {
    assert.throws(() => requireStage51ExternalInputRegister(value), {
      code: "CLOUD_STAGE51_EXTERNAL_INPUT_REGISTER_INVALID",
    });
  }
  const otherValidSha = copy(blockedRegister());
  otherValidSha.main_sha = "1111111111111111111111111111111111111111";
  assert.throws(() => requireStage51ExternalInputRegister(otherValidSha, { mainSha: MAIN_SHA }), {
    code: "CLOUD_STAGE51_EXTERNAL_INPUT_REGISTER_INVALID",
  });
  for (const binding of [null, { extra: true }, { mainSha: undefined }]) {
    assert.throws(() => requireStage51ExternalInputRegister(blockedRegister(), binding), {
      code: "CLOUD_STAGE51_EXTERNAL_INPUT_REGISTER_INVALID",
    });
  }
});

test("each input accepts only its exact blocker or a reference-complete authorized state", () => {
  const wrongBlocker = copy(blockedRegister());
  wrongBlocker.inputs.environment.state = "blocked_external_offsite";
  const blockerWithReference = copy(blockedRegister());
  blockerWithReference.inputs.environment.owner_ref = "owner:platform-operator";
  const authorizedMissingReference = authorizedRegister();
  authorizedMissingReference.inputs.alerting.receipt_contract_ref = null;
  const unknownState = copy(blockedRegister());
  unknownState.inputs.capacity.state = "ready";
  const secretKey = copy(blockedRegister());
  secretKey.inputs.offsite.password = "forbidden";
  for (const value of [
    wrongBlocker,
    blockerWithReference,
    authorizedMissingReference,
    unknownState,
    secretKey,
  ]) {
    assert.throws(() => requireStage51ExternalInputRegister(value), {
      code: "CLOUD_STAGE51_EXTERNAL_INPUT_REGISTER_INVALID",
    });
  }
});

test("references are opaque typed identifiers and reject secret-like or path-ambiguous values", () => {
  const cases = [
    ["environment", "authorization_ref", "https://tracker.invalid/OPS-5101"],
    ["environment", "candidate_identity_ref", "asset:../candidate"],
    ["environment", "owner_ref", "owner:platform-secret-owner"],
    ["offsite", "target_identity_ref", "owner:backup-operator"],
    ["alerting", "receipt_contract_ref", "document:stage51//receipt"],
    ["capacity", "profile_ref", "ticket:PRODUCT-5104"],
  ];
  for (const [input, field, reference] of cases) {
    const value = authorizedRegister();
    value.inputs[input][field] = reference;
    assert.throws(() => requireStage51ExternalInputRegister(value), {
      code: "CLOUD_STAGE51_EXTERNAL_INPUT_REGISTER_INVALID",
    });
  }
});

test("canonical parser rejects malformed, padded, non-canonical, and oversized JSON", () => {
  const register = blockedRegister();
  const canonical = canonicalStage51ExternalInputRegister(register);
  assert.throws(() => parseStage51ExternalInputRegister("{"), {
    code: "CLOUD_STAGE51_EXTERNAL_INPUT_JSON_INVALID",
  });
  assert.throws(() => parseStage51ExternalInputRegister(`${canonical}\n`), {
    code: "CLOUD_STAGE51_EXTERNAL_INPUT_NOT_CANONICAL",
  });
  assert.throws(() => parseStage51ExternalInputRegister(JSON.stringify(register)), {
    code: "CLOUD_STAGE51_EXTERNAL_INPUT_NOT_CANONICAL",
  });
  assert.throws(
    () => parseStage51ExternalInputRegister("x".repeat(STAGE51_EXTERNAL_INPUT_MAX_BYTES + 1)),
    {
      code: "CLOUD_STAGE51_EXTERNAL_INPUT_JSON_INVALID",
    },
  );
});

test("committed Stage 5.1 register is canonical and remains externally blocked", async () => {
  const source = await readFile(CURRENT_REGISTER, "utf8");
  const register = parseStage51ExternalInputRegister(source, { mainSha: MAIN_SHA });
  assert.equal(register.main_sha, MAIN_SHA);
  assert.deepEqual(summarizeStage51ExternalInputRegister(register), {
    blockers: STAGE51_EXTERNAL_BLOCKERS,
    ready_for_profile_registration: false,
  });
});

test("malformed JSON errors do not retain source text or a parser cause", () => {
  const source = '{"secret":"synthetic-sensitive-marker",broken}';
  assert.throws(
    () => parseStage51ExternalInputRegister(source),
    (error) => {
      assert.equal(error.code, "CLOUD_STAGE51_EXTERNAL_INPUT_JSON_INVALID");
      assert.equal(error.cause, undefined);
      assert.equal(error.stack.includes("synthetic-sensitive-marker"), false);
      return true;
    },
  );
});

test("canonical parsing rejects duplicate keys and enforces the caller's SHA binding", () => {
  const source = canonicalStage51ExternalInputRegister(authorizedRegister());
  const duplicate = source.replace('"version":1', '"version":1,"version":1');
  assert.throws(() => parseStage51ExternalInputRegister(duplicate), {
    code: "CLOUD_STAGE51_EXTERNAL_INPUT_NOT_CANONICAL",
  });
  assert.throws(() => parseStage51ExternalInputRegister(source, { mainSha: "1".repeat(40) }), {
    code: "CLOUD_STAGE51_EXTERNAL_INPUT_REGISTER_INVALID",
  });
  assert.deepEqual(
    parseStage51ExternalInputRegister(source, { mainSha: MAIN_SHA }),
    requireStage51ExternalInputRegister(authorizedRegister()),
  );
});
