import { exactKeys, fail } from "./companion-contract.mjs";
import { requireState } from "./lifecycle-storage.mjs";

function release(value) {
  requireState({
    schema: 1,
    assurance: "development_only",
    phase: "stopped",
    current: value,
    previous: null,
    controller: value,
    pending: null,
    releases: [value],
  });
  return value;
}
function point(value, nullable = false) {
  if (nullable && value === null) return;
  if (
    !exactKeys(value, ["id", "digest"]) ||
    typeof value.id !== "string" ||
    typeof value.digest !== "string" ||
    !/^b_[a-f0-9]{32}$/u.test(value.id) ||
    !/^[a-f0-9]{64}$/u.test(value.digest)
  )
    fail("UPGRADE_STATE_INVALID");
}
export function requireUpgradeHistory(value) {
  if (!Array.isArray(value) || value.length > 15) fail("UPGRADE_HISTORY_INVALID");
  for (const record of value) {
    if (!exactKeys(record, ["from", "to", "before", "after"])) fail("UPGRADE_HISTORY_INVALID");
    release(record.from);
    release(record.to);
    point(record.before);
    point(record.after);
  }
  return value;
}
export function requireUpgradeJournal(value) {
  if (
    !exactKeys(value, [
      "version",
      "operation",
      "phase",
      "was_running",
      "release",
      "next",
      "safety",
      "target",
      "candidate",
      "old_state",
      "after",
    ]) ||
    value.version !== 2 ||
    !["schema-upgrade", "schema-rollback"].includes(value.operation) ||
    ![
      "quiescing",
      "prepared",
      "restoring",
      "migrating",
      "switching",
      "program",
      "verified",
    ].includes(value.phase) ||
    typeof value.was_running !== "boolean"
  )
    fail("UPGRADE_STATE_INVALID");
  release(value.release);
  release(value.next);
  requireState(value.old_state);
  if (JSON.stringify(value.old_state.current) !== JSON.stringify(value.release))
    fail("UPGRADE_STATE_INVALID");
  if (
    !value.old_state.releases.some((entry) => JSON.stringify(entry) === JSON.stringify(value.next))
  )
    fail("UPGRADE_STATE_INVALID");
  point(value.safety, true);
  point(value.target, true);
  point(value.after, true);
  if (value.candidate !== null) {
    const candidate = value.candidate;
    if (
      !exactKeys(candidate, ["name", "previous", "original_oid", "restored_oid"]) ||
      !/^laundry_restore_[a-f0-9]{32}$/u.test(candidate.name) ||
      candidate.previous !== candidate.name.replace("laundry_restore_", "laundry_previous_") ||
      !Number.isSafeInteger(candidate.original_oid) ||
      candidate.original_oid < 1 ||
      !(
        candidate.restored_oid === null ||
        (Number.isSafeInteger(candidate.restored_oid) &&
          candidate.restored_oid > 0 &&
          candidate.restored_oid !== candidate.original_oid)
      )
    )
      fail("UPGRADE_STATE_INVALID");
  }
  if (value.candidate && !value.safety) fail("UPGRADE_STATE_INVALID");
  if (value.phase !== "quiescing" && !value.safety) fail("UPGRADE_STATE_INVALID");
  if (
    ["migrating", "switching", "program", "verified"].includes(value.phase) &&
    !value.candidate?.restored_oid
  )
    fail("UPGRADE_STATE_INVALID");
  if (["program", "verified"].includes(value.phase) && !value.after) fail("UPGRADE_STATE_INVALID");
  return value;
}
export function requireMigrationExtension(previous, next) {
  if (previous.sources.postgres.version !== next.sources.postgres.version)
    fail("UPGRADE_POSTGRES_VERSION_INVALID");
  const migrations = (manifest) =>
    manifest.files
      .filter((file) => /^migrations\/\d{4}_[a-z0-9_]+\.sql$/u.test(file.path))
      .sort((a, b) => a.path.localeCompare(b.path));
  const old = migrations(previous),
    incoming = migrations(next);
  if (
    !old.length ||
    incoming.length <= old.length ||
    old.some(
      (file, index) =>
        file.path !== incoming[index].path ||
        file.sha256 !== incoming[index].sha256 ||
        file.size !== incoming[index].size,
    )
  )
    fail("UPGRADE_MIGRATION_HISTORY_CHANGED");
}
