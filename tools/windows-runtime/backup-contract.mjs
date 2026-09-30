import { exactKeys, fail } from "./companion-contract.mjs";
import { requireState } from "./lifecycle-storage.mjs";

export const BACKUP_ACTIONS = Object.freeze([
  "backup",
  "backup-list",
  "backup-verify",
  "restore",
  "maintenance-recover",
]);
export const MAX_BACKUPS = 32;
export const MAX_DUMP_BYTES = 512 * 1024 * 1024;
export const BACKUP_ID = /^b_[a-f0-9]{32}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const DATABASE = /^laundry_(?:restore|previous)_[a-f0-9]{32}$/u;
const matches = (pattern, value) => typeof value === "string" && pattern.test(value);

export function requireBackupOptions(action, options = {}) {
  const keys =
    action === "restore"
      ? ["backupId", "confirmation"]
      : action === "backup-verify"
        ? ["backupId"]
        : [];
  if (
    !exactKeys(options, keys) ||
    (keys.includes("backupId") && !matches(BACKUP_ID, options.backupId)) ||
    (keys.includes("confirmation") && !matches(SHA, options.confirmation))
  )
    fail("ARGS_INVALID");
  return options;
}

export function requireRelease(entry) {
  const keys = ["digest", "release", "source", "migrationHead", "migrations"];
  if (!exactKeys(entry, keys) || keys.some((key) => typeof entry[key] !== "string"))
    fail("STATE_INVALID");
  requireState({
    schema: 1,
    assurance: "development_only",
    phase: "stopped",
    current: entry,
    previous: null,
    controller: entry,
    pending: null,
    releases: [entry],
  });
  return entry;
}

export function requireBackup(value) {
  if (
    !exactKeys(value, [
      "schema",
      "version",
      "assurance",
      "id",
      "instance_sha256",
      "created_at",
      "release",
      "postgres_version",
      "photos",
      "database",
    ]) ||
    value.schema !== "laundry.windows.backup" ||
    value.version !== 1 ||
    value.assurance !== "development_only" ||
    !matches(BACKUP_ID, value.id) ||
    !matches(SHA, value.instance_sha256) ||
    typeof value.created_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.created_at) ||
    !Number.isFinite(Date.parse(value.created_at)) ||
    value.photos !== "disabled_empty" ||
    typeof value.postgres_version !== "string" ||
    !/^16\.\d+$/u.test(value.postgres_version) ||
    !exactKeys(value.database, ["size", "sha256"]) ||
    !Number.isSafeInteger(value.database.size) ||
    value.database.size < 1 ||
    value.database.size > MAX_DUMP_BYTES ||
    !matches(SHA, value.database.sha256)
  )
    fail("BACKUP_INVALID");
  requireRelease(value.release);
  return value;
}

export function requireMaintenance(value) {
  if (exactKeys(value, ["version", "phase"]) && value.version === 1 && value.phase === "idle")
    return null;
  if (
    !exactKeys(value, [
      "version",
      "operation",
      "phase",
      "was_running",
      "release",
      "target",
      "safety",
      "candidate",
    ]) ||
    value.version !== 1 ||
    !["backup", "restore"].includes(value.operation) ||
    !["quiescing", "prepared", "restoring", "switching", "verified"].includes(value.phase) ||
    typeof value.was_running !== "boolean"
  )
    fail("MAINTENANCE_STATE_INVALID");
  requireRelease(value.release);
  for (const bound of [value.target, value.safety]) {
    if (
      bound !== null &&
      (!exactKeys(bound, ["id", "digest"]) ||
        !matches(BACKUP_ID, bound.id) ||
        !matches(SHA, bound.digest))
    )
      fail("MAINTENANCE_STATE_INVALID");
  }
  if (
    (value.operation === "backup" && (value.target !== null || value.candidate !== null)) ||
    (value.operation === "restore" && value.target === null)
  )
    fail("MAINTENANCE_STATE_INVALID");
  if (value.candidate !== null) {
    const candidate = value.candidate;
    if (
      !exactKeys(candidate, ["name", "previous", "original_oid", "restored_oid"]) ||
      !matches(DATABASE, candidate.name) ||
      !candidate.name.startsWith("laundry_restore_") ||
      candidate.previous !== candidate.name.replace("laundry_restore_", "laundry_previous_") ||
      !Number.isSafeInteger(candidate.original_oid) ||
      candidate.original_oid < 1 ||
      (candidate.restored_oid !== null &&
        (!Number.isSafeInteger(candidate.restored_oid) ||
          candidate.restored_oid < 1 ||
          candidate.restored_oid === candidate.original_oid))
    )
      fail("MAINTENANCE_STATE_INVALID");
  }
  if (
    (value.candidate !== null && value.safety === null) ||
    (["switching", "verified"].includes(value.phase) &&
      (!value.candidate || !value.candidate.restored_oid))
  )
    fail("MAINTENANCE_STATE_INVALID");
  return value;
}
