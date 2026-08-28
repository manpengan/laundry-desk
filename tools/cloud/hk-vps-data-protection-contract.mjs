import { basename, dirname, join } from "node:path";

import { DEFAULT_CLOUD_ENVIRONMENT_PROFILE } from "./cloud-environment-profile.mjs";
import { fail, requireSha } from "./hk-vps-release-core.mjs";

const PROFILE = DEFAULT_CLOUD_ENVIRONMENT_PROFILE;

export const DATA_PROTECTION_ROOT = PROFILE.paths.dataProtectionRoot;
export const DATA_PROTECTION_SET_ROOT = `${DATA_PROTECTION_ROOT}/sets`;
export const DATA_PROTECTION_STATE_PATH = `${DATA_PROTECTION_ROOT}/state.json`;
export const DATA_PROTECTION_OPERATION_PATH = `${DATA_PROTECTION_ROOT}/operation.json`;
export const DATA_PROTECTION_STATUS_PATH = `${DATA_PROTECTION_ROOT}/status.json`;
export const DATA_PROTECTION_PHOTO_ROOT = PROFILE.paths.dataProtectionPhotoRoot;
export const DATA_PROTECTION_OFFSITE_ROOT = PROFILE.paths.dataProtectionOffsiteRoot;
export const DATA_PROTECTION_OFFSITE_MARKER = PROFILE.markers.offsiteStoreFile;
export const DATA_PROTECTION_PHOTO_MARKER = PROFILE.markers.photoStoreFile;
export const DATA_PROTECTION_PHOTO_MARKER_CONTENT = PROFILE.markers.photoStoreContent;
export const DATA_PROTECTION_ENVIRONMENT = PROFILE.environmentMarker;
export const DATA_PROTECTION_MAX_SETS = 8;
export const DATA_PROTECTION_MAX_OFFSITE_SETS = 30;
export const DATA_PROTECTION_BACKUP_MAX_AGE_SECONDS = 26 * 60 * 60;
export const DATA_PROTECTION_DRILL_MAX_AGE_SECONDS = 8 * 24 * 60 * 60;

const DIGEST = /^[0-9a-f]{64}$/u;
const SET_ID = /^(manual|scheduled|pre_recovery)-\d{8}T\d{6}Z-[0-9a-f]{16}$/u;
const PHOTO_KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/u;
const MIGRATION_HEAD = /^\d{4}_[a-z0-9_]+\.sql$/u;
const KINDS = new Set(["manual", "scheduled", "pre_recovery"]);
const OPERATION_ACTIONS = new Set(["backup", "drill", "offsite", "recover"]);
const OPERATION_PHASES = new Set([
  "intent",
  "service_stopped",
  "gate_intent",
  "gate_active",
  "capturing",
  "verifying",
  "restoring",
  "recovery_required",
  "gate_released",
]);

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

function safeCount(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function requireDigest(value, code) {
  if (typeof value !== "string" || !DIGEST.test(value)) fail(code);
  return value;
}

export function requireDataProtectionSetId(value) {
  if (typeof value !== "string" || !SET_ID.test(value)) {
    fail("CLOUD_DATA_SET_ID_INVALID");
  }
  return value;
}

export function requirePhotoStorageKey(value) {
  if (typeof value !== "string" || !PHOTO_KEY.test(value)) {
    fail("CLOUD_DATA_PHOTO_INVENTORY_INVALID");
  }
  return value;
}

export function createDataProtectionSetId(kind, date, randomHex) {
  if (!KINDS.has(kind) || !(date instanceof Date) || Number.isNaN(date.getTime())) {
    fail("CLOUD_DATA_SET_ID_INVALID");
  }
  if (typeof randomHex !== "string" || !/^[0-9a-f]{16}$/u.test(randomHex)) {
    fail("CLOUD_DATA_SET_ID_INVALID");
  }
  const timestamp = date.toISOString().slice(0, 19).replaceAll("-", "").replaceAll(":", "") + "Z";
  return requireDataProtectionSetId(`${kind}-${timestamp}-${randomHex}`);
}

export function dataProtectionSetPath(setId, root = DATA_PROTECTION_SET_ROOT) {
  const id = requireDataProtectionSetId(setId);
  const path = join(root, id);
  if (dirname(path) !== root || basename(path) !== id) fail("CLOUD_DATA_SET_PATH_INVALID");
  return path;
}

function parsePhotoEntry(value) {
  if (
    !exactKeys(value, ["storage_key", "bytes", "sha256"]) ||
    !safeCount(value.bytes, 8 * 1024 * 1024) ||
    value.bytes < 1
  ) {
    fail("CLOUD_DATA_PHOTO_INVENTORY_INVALID");
  }
  return Object.freeze({
    storage_key: requirePhotoStorageKey(value.storage_key),
    bytes: value.bytes,
    sha256: requireDigest(value.sha256, "CLOUD_DATA_PHOTO_INVENTORY_INVALID"),
  });
}

export function parseDataProtectionManifest(value) {
  if (
    !exactKeys(value, [
      "schema",
      "version",
      "set_id",
      "kind",
      "environment",
      "code_sha",
      "created_at",
      "migration",
      "database",
      "photos",
    ]) ||
    value.schema !== "laundry.cloud-data-protection.set" ||
    value.version !== 1 ||
    !KINDS.has(value.kind) ||
    value.environment !== DATA_PROTECTION_ENVIRONMENT ||
    !canonicalTimestamp(value.created_at) ||
    !exactKeys(value.migration, ["head", "count", "ledger_sha256", "catalog_sha256"]) ||
    !MIGRATION_HEAD.test(value.migration.head) ||
    !safeCount(value.migration.count, 10_000) ||
    value.migration.count < 1 ||
    !exactKeys(value.database, ["file", "bytes", "sha256"]) ||
    value.database.file !== "database.dump" ||
    !safeCount(value.database.bytes) ||
    value.database.bytes < 1 ||
    !exactKeys(value.photos, ["directory", "count", "bytes", "inventory_sha256", "files"]) ||
    value.photos.directory !== "photos" ||
    !safeCount(value.photos.count, 10_000) ||
    !safeCount(value.photos.bytes, 2 * 1024 * 1024 * 1024) ||
    !Array.isArray(value.photos.files) ||
    value.photos.files.length !== value.photos.count
  ) {
    fail("CLOUD_DATA_MANIFEST_INVALID");
  }
  const setId = requireDataProtectionSetId(value.set_id);
  if (!setId.startsWith(`${value.kind}-`)) fail("CLOUD_DATA_MANIFEST_INVALID");
  const files = value.photos.files.map(parsePhotoEntry);
  const names = files.map((entry) => entry.storage_key);
  if (
    new Set(names).size !== names.length ||
    names.some((name, index) => index > 0 && name <= names[index - 1]) ||
    files.reduce((total, entry) => total + entry.bytes, 0) !== value.photos.bytes
  ) {
    fail("CLOUD_DATA_PHOTO_INVENTORY_INVALID");
  }
  return Object.freeze({
    schema: value.schema,
    version: value.version,
    set_id: setId,
    kind: value.kind,
    environment: value.environment,
    code_sha: requireSha(value.code_sha, "CLOUD_DATA_MANIFEST_INVALID"),
    created_at: value.created_at,
    migration: Object.freeze({
      head: value.migration.head,
      count: value.migration.count,
      ledger_sha256: requireDigest(value.migration.ledger_sha256, "CLOUD_DATA_MANIFEST_INVALID"),
      catalog_sha256: requireDigest(value.migration.catalog_sha256, "CLOUD_DATA_MANIFEST_INVALID"),
    }),
    database: Object.freeze({
      file: value.database.file,
      bytes: value.database.bytes,
      sha256: requireDigest(value.database.sha256, "CLOUD_DATA_MANIFEST_INVALID"),
    }),
    photos: Object.freeze({
      directory: value.photos.directory,
      count: value.photos.count,
      bytes: value.photos.bytes,
      inventory_sha256: requireDigest(value.photos.inventory_sha256, "CLOUD_DATA_MANIFEST_INVALID"),
      files: Object.freeze(files),
    }),
  });
}

export function parseDataProtectionVerification(value) {
  if (
    !exactKeys(value, [
      "schema",
      "version",
      "set_id",
      "manifest_sha256",
      "migration_ledger_sha256",
      "catalog_sha256",
      "photo_inventory_sha256",
      "completed_at",
    ]) ||
    value.schema !== "laundry.cloud-data-protection.verification" ||
    value.version !== 1 ||
    !canonicalTimestamp(value.completed_at)
  ) {
    fail("CLOUD_DATA_VERIFICATION_INVALID");
  }
  return Object.freeze({
    ...value,
    set_id: requireDataProtectionSetId(value.set_id),
    manifest_sha256: requireDigest(value.manifest_sha256, "CLOUD_DATA_VERIFICATION_INVALID"),
    migration_ledger_sha256: requireDigest(
      value.migration_ledger_sha256,
      "CLOUD_DATA_VERIFICATION_INVALID",
    ),
    catalog_sha256: requireDigest(value.catalog_sha256, "CLOUD_DATA_VERIFICATION_INVALID"),
    photo_inventory_sha256: requireDigest(
      value.photo_inventory_sha256,
      "CLOUD_DATA_VERIFICATION_INVALID",
    ),
  });
}

export function parseDataProtectionOperation(value) {
  if (
    !exactKeys(value, [
      "schema",
      "version",
      "operation_id",
      "action",
      "phase",
      "set_id",
      "pre_recovery_set_id",
      "app_role_original_can_login",
      "created_at",
      "updated_at",
    ]) ||
    value.schema !== "laundry.cloud-data-protection.operation" ||
    value.version !== 1 ||
    typeof value.operation_id !== "string" ||
    !/^[0-9a-f]{32}$/u.test(value.operation_id) ||
    !OPERATION_ACTIONS.has(value.action) ||
    !OPERATION_PHASES.has(value.phase) ||
    !canonicalTimestamp(value.created_at) ||
    !canonicalTimestamp(value.updated_at) ||
    ![null, true].includes(value.app_role_original_can_login) ||
    ["intent", "service_stopped"].includes(value.phase) !==
      (value.app_role_original_can_login === null)
  ) {
    fail("CLOUD_DATA_OPERATION_INVALID");
  }
  const preRecoverySetId =
    value.pre_recovery_set_id === null
      ? null
      : requireDataProtectionSetId(value.pre_recovery_set_id);
  if (
    (value.action === "recover") !== (preRecoverySetId !== null) ||
    (preRecoverySetId !== null && !preRecoverySetId.startsWith("pre_recovery-"))
  ) {
    fail("CLOUD_DATA_OPERATION_INVALID");
  }
  return Object.freeze({
    ...value,
    set_id: value.set_id === null ? null : requireDataProtectionSetId(value.set_id),
    pre_recovery_set_id: preRecoverySetId,
  });
}

export function createDataProtectionManifest(input) {
  return parseDataProtectionManifest({
    schema: "laundry.cloud-data-protection.set",
    version: 1,
    environment: DATA_PROTECTION_ENVIRONMENT,
    ...input,
  });
}

export function createDataProtectionVerification(input) {
  return parseDataProtectionVerification({
    schema: "laundry.cloud-data-protection.verification",
    version: 1,
    ...input,
  });
}

export {
  emptyDataProtectionState,
  parseDataProtectionState,
} from "./hk-vps-data-protection-state-contract.mjs";
