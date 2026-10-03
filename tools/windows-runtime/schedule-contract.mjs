import { exactKeys, fail } from "./companion-contract.mjs";
import { BACKUP_ID } from "./backup-contract.mjs";

export const SCHEDULE_ACTIONS = Object.freeze([
  "backup-schedule",
  "backup-health",
  "scheduled-backup",
]);
export const DEFAULT_SCHEDULE = Object.freeze({
  version: 1,
  enabled: false,
  hour: 3,
  minute: 0,
  retain_count: 14,
  retain_days: 30,
  minimum_free_mib: 2048,
  drill_days: 7,
});

export function requireSchedule(value) {
  if (
    !exactKeys(value, Object.keys(DEFAULT_SCHEDULE)) ||
    value.version !== 1 ||
    typeof value.enabled !== "boolean"
  )
    fail("BACKUP_SCHEDULE_INVALID");
  for (const [name, minimum, maximum] of [
    ["hour", 0, 23],
    ["minute", 0, 59],
    ["retain_count", 2, 24],
    ["retain_days", 1, 365],
    ["minimum_free_mib", 512, 1048576],
    ["drill_days", 1, 30],
  ])
    if (!Number.isSafeInteger(value[name]) || value[name] < minimum || value[name] > maximum)
      fail("BACKUP_SCHEDULE_INVALID");
  return value;
}

export function requireScheduleHistory(value) {
  if (!Array.isArray(value) || value.length > 50) fail("BACKUP_HISTORY_INVALID");
  for (const record of value) {
    if (
      !exactKeys(record, ["at", "status", "code", "backup_id", "drilled"]) ||
      typeof record.at !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(record.at) ||
      !Number.isFinite(Date.parse(record.at)) ||
      !["succeeded", "failed", "started"].includes(record.status) ||
      typeof record.drilled !== "boolean" ||
      !(
        record.backup_id === null ||
        (typeof record.backup_id === "string" && BACKUP_ID.test(record.backup_id))
      ) ||
      !(
        record.code === null ||
        (typeof record.code === "string" && /^WINDOWS_COMPANION_[A-Z_]{1,80}$/u.test(record.code))
      )
    )
      fail("BACKUP_HISTORY_INVALID");
  }
  return value;
}
