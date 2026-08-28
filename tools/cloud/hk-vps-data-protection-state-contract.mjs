import { dirname } from "node:path";

import { HK_VPS_CLOUD_TEST as PROFILE } from "./cloud-environment-profile.mjs";
import { fail, requireSha } from "./hk-vps-release-core.mjs";

const DIGEST = /^[0-9a-f]{64}$/u;
const SET_ID = /^(manual|scheduled|pre_recovery)-\d{8}T\d{6}Z-[0-9a-f]{16}$/u;
const ACTIONS = Object.freeze(["backup", "drill", "offsite", "recover"]);
const TARGET_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const REMOTE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9:+/=_@.-]{7,255}$/u;
const ROLLBACK_CODE_PATH = new RegExp(
  `^${dirname(PROFILE.paths.liveRoot)}/${PROFILE.markers.releaseTreeName}\\.rollback-pre-[0-9a-f]{7}-\\d{8}T\\d{6}Z$`,
  "u",
);

function exactKeys(value, expected) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === [...expected].sort().join(",")
  );
}

function canonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function requireSetId(value) {
  if (typeof value !== "string" || !SET_ID.test(value)) fail("CLOUD_DATA_STATE_INVALID");
  return value;
}

function requireDigest(value) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail("CLOUD_DATA_STATE_INVALID");
  return value;
}

function parseStateSet(value, kind) {
  const common = ["set_id", "completed_at", "manifest_sha256"];
  const expected =
    kind === "backup"
      ? [...common, "code_sha"]
      : kind === "recovery"
        ? [...common, "code_sha", "pre_recovery_set_id", "rollback_code_path"]
        : kind === "offsite"
          ? [...common, "target_id", "failure_domain", "remote_identity"]
          : common;
  if (!exactKeys(value, expected) || !canonicalTimestamp(value.completed_at)) {
    fail("CLOUD_DATA_STATE_INVALID");
  }
  const result = {
    ...value,
    set_id: requireSetId(value.set_id),
    manifest_sha256: requireDigest(value.manifest_sha256),
  };
  if (kind === "backup" || kind === "recovery") {
    result.code_sha = requireSha(value.code_sha, "CLOUD_DATA_STATE_INVALID");
  }
  if (kind === "recovery") {
    result.pre_recovery_set_id = requireSetId(value.pre_recovery_set_id);
    if (
      !result.pre_recovery_set_id.startsWith("pre_recovery-") ||
      typeof value.rollback_code_path !== "string" ||
      !ROLLBACK_CODE_PATH.test(value.rollback_code_path)
    ) {
      fail("CLOUD_DATA_STATE_INVALID");
    }
  }
  if (
    kind === "offsite" &&
    (!TARGET_ID.test(value.target_id) ||
      !TARGET_ID.test(value.failure_domain) ||
      !REMOTE_IDENTITY.test(value.remote_identity))
  ) {
    fail("CLOUD_DATA_STATE_INVALID");
  }
  return Object.freeze(result);
}

function parseFailure(value) {
  if (
    !exactKeys(value, ["code", "failed_at"]) ||
    typeof value.code !== "string" ||
    !/^CLOUD_DATA_[A-Z0-9_]{3,96}$/u.test(value.code) ||
    !canonicalTimestamp(value.failed_at)
  ) {
    fail("CLOUD_DATA_STATE_INVALID");
  }
  return Object.freeze({ ...value });
}

export function parseDataProtectionState(value) {
  if (
    !exactKeys(value, [
      "schema",
      "version",
      "last_backup",
      "last_offsite",
      "last_drill",
      "last_recovery",
      "last_failure",
    ]) ||
    value.schema !== "laundry.cloud-data-protection.state" ||
    value.version !== 1 ||
    !exactKeys(value.last_failure, ACTIONS)
  ) {
    fail("CLOUD_DATA_STATE_INVALID");
  }
  const failures = Object.fromEntries(
    ACTIONS.map((action) => [
      action,
      value.last_failure[action] === null ? null : parseFailure(value.last_failure[action]),
    ]),
  );
  return Object.freeze({
    schema: value.schema,
    version: value.version,
    last_backup: value.last_backup === null ? null : parseStateSet(value.last_backup, "backup"),
    last_offsite: value.last_offsite === null ? null : parseStateSet(value.last_offsite, "offsite"),
    last_drill: value.last_drill === null ? null : parseStateSet(value.last_drill, "drill"),
    last_recovery:
      value.last_recovery === null ? null : parseStateSet(value.last_recovery, "recovery"),
    last_failure: Object.freeze(failures),
  });
}

export function emptyDataProtectionState() {
  return parseDataProtectionState({
    schema: "laundry.cloud-data-protection.state",
    version: 1,
    last_backup: null,
    last_offsite: null,
    last_drill: null,
    last_recovery: null,
    last_failure: Object.fromEntries(ACTIONS.map((action) => [action, null])),
  });
}
