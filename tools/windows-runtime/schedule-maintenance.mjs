import { readBackupHealthRecord } from "./backup-health-record.mjs";
import { rm, statfs } from "node:fs/promises";
import { join } from "node:path";
import { digest, exactKeys, fail } from "./companion-contract.mjs";
import { exists } from "./lifecycle-storage.mjs";
import { backupMaintenance } from "./backup-maintenance.mjs";
import { cleanEnvironment } from "./lifecycle-environment.mjs";
import { run } from "./lifecycle-process.mjs";
import { DEFAULT_SCHEDULE, requireSchedule, requireScheduleHistory } from "./schedule-contract.mjs";
import { pruneBackups } from "./schedule-retention.mjs";
import { readMaintenance } from "./backup-files.mjs";
import { managedScheduleTask, clearScheduleController } from "./schedule-controller.mjs";

async function read(context, name, fallback, validate) {
  const path = join(context.root, name);
  return (await exists(path)) ? validate(JSON.parse(await context.io.read(path))) : fallback;
}
export async function scheduleConfiguration(context) {
  return read(context, "backup-schedule.json", DEFAULT_SCHEDULE, requireSchedule);
}
async function history(context) {
  return read(context, "backup-history.json", [], requireScheduleHistory);
}
// ADR-91 D-4: local restore points die with the disk; remind until an off-machine copy is recent.
const OFFSITE_DAYS = 7;
function requireOffsite(value) {
  if (
    !exactKeys(value, ["version", "at"]) ||
    value.version !== 1 ||
    typeof value.at !== "string" ||
    !Number.isFinite(Date.parse(value.at))
  )
    fail("OFFSITE_RECORD_INVALID");
  return value;
}
export async function recordOffsiteExport(context, now = Date.now()) {
  await context.io.write(
    join(context.root, "offsite-export.json"),
    JSON.stringify({ version: 1, at: new Date(now).toISOString() }),
  );
}
async function available(context) {
  const space = await statfs(context.root, { bigint: true });
  return Number((space.bavail * space.bsize) / 1048576n);
}
export async function scheduleTask(context, verb, config) {
  const env = cleanEnvironment();
  const output = await run(
    join(env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(context.payload, "scripts/schedule-task.ps1"),
      "-Verb",
      verb,
      "-Root",
      context.root,
      "-Payload",
      context.payload,
      "-ManifestDigest",
      context.entry.digest,
      "-Hour",
      String(config.hour),
      "-Minute",
      String(config.minute),
    ],
    env,
    context.root,
  );
  const value = JSON.parse(output);
  if (!value || Object.keys(value).length !== 1 || typeof value.exists !== "boolean")
    fail("BACKUP_TASK_RESULT_INVALID");
  return value;
}
export async function scheduleHealth(context, now = Date.now(), task = scheduleTask) {
  const config = await scheduleConfiguration(context),
    records = await history(context);
  const free = await available(context),
    latest = records.at(-1);
  const success = records.findLast((record) => record.status === "succeeded");
  const drill = records.findLast((record) => record.status === "succeeded" && record.drilled);
  const manual = await readBackupHealthRecord(context);
  const mostRecent = (left, right) =>
    !left ? right : !right ? left : Date.parse(left) > Date.parse(right) ? left : right;
  const lastBackup = mostRecent(success?.at ?? null, manual.last_backup_at);
  const lastDrill = mostRecent(drill?.at ?? null, manual.last_drill_at);
  const next = new Date(now);
  next.setHours(config.hour, config.minute, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  const alerts = [];
  if (!config.enabled) alerts.push("backup_disabled");
  if (await readMaintenance(context.io, context.root)) alerts.push("interrupted");
  if (config.enabled) {
    try {
      if (!(await managedScheduleTask(context, "inspect", config, task)).exists)
        alerts.push("task_missing");
    } catch {
      alerts.push("task_unavailable");
    }
  }
  if (free < config.minimum_free_mib) alerts.push("low_space");
  if (latest && latest.status !== "succeeded") {
    const alert = latest.status === "started" ? "interrupted" : "last_run_failed";
    if (!alerts.includes(alert)) alerts.push(alert);
  }
  if (config.enabled && (!lastBackup || now - Date.parse(lastBackup) > 2 * 86400000))
    alerts.push("backup_overdue");
  if (config.enabled && (!lastDrill || now - Date.parse(lastDrill) > config.drill_days * 86400000))
    alerts.push("drill_overdue");
  const offsite = await read(context, "offsite-export.json", null, requireOffsite);
  if (!offsite || now - Date.parse(offsite.at) > OFFSITE_DAYS * 86400000)
    alerts.push("offsite_overdue");
  return {
    status: "backup_health",
    checked_at: new Date(now).toISOString(),
    last_backup_at: lastBackup,
    last_drill_at: lastDrill,
    last_offsite_at: offsite?.at ?? null,
    next_backup_at:
      config.enabled && !alerts.includes("task_missing") && !alerts.includes("task_unavailable")
        ? next.toISOString()
        : null,
    config,
    latest: latest ?? null,
    free_mib: free,
    alerts,
    assurance: "development_only",
  };
}
export async function scheduledMaintenance(action, options, lifecycle, dependencies = {}) {
  const state = lifecycle.getState();
  const bound = await lifecycle.verify(state.current);
  const context = {
    ...lifecycle,
    payload: bound.payload,
    entry: state.current,
    instance: digest(await lifecycle.io.read(join(lifecycle.root, "secrets/access-token-secret"))),
    postgresVersion: bound.manifest.sources.postgres.version,
  };
  const task = dependencies.task ?? scheduleTask;
  if (action === "backup-health") return scheduleHealth(context, Date.now(), task);
  if (action === "backup-schedule") {
    if (
      state.pending ||
      !["running", "stopped", "initialized"].includes(state.phase) ||
      (await readMaintenance(context.io, context.root))
    )
      fail("MAINTENANCE_RECOVERY_REQUIRED");
    const config = requireSchedule(options);
    // A registration failure can never enable an unrecorded configuration.
    await context.io.write(
      join(context.root, "backup-schedule.json"),
      JSON.stringify({ ...config, enabled: false }),
    );
    await managedScheduleTask(context, config.enabled ? "register" : "remove", config, task);
    await context.io.write(join(context.root, "backup-schedule.json"), JSON.stringify(config));
    return scheduleHealth(context, Date.now(), task);
  }
  const config = await scheduleConfiguration(context);
  if (!config.enabled) return { status: "backup_schedule_disabled", assurance: "development_only" };
  const records = await history(context),
    now = (dependencies.now ?? Date.now)();
  const started = {
    at: new Date(now).toISOString(),
    status: "started",
    code: null,
    backup_id: null,
    drilled: false,
  };
  const save = async (record) =>
    context.io.write(
      join(context.root, "backup-history.json"),
      JSON.stringify(requireScheduleHistory([...records.slice(-49), record])),
    );
  await save(started);
  try {
    if (
      state.pending ||
      !["running", "stopped", "initialized"].includes(state.phase) ||
      (await readMaintenance(context.io, context.root))
    )
      fail("MAINTENANCE_RECOVERY_REQUIRED");
    if ((await (dependencies.available ?? available)(context)) < config.minimum_free_mib)
      fail("BACKUP_SPACE_INSUFFICIENT");
    await (dependencies.prune ?? pruneBackups)(context, config, [], now);
    const maintenance = dependencies.backupMaintenance ?? backupMaintenance;
    const point = await maintenance("backup", {}, lifecycle);
    const lastDrill = records.findLast((record) => record.status === "succeeded" && record.drilled);
    const drill = !lastDrill || now - Date.parse(lastDrill.at) >= config.drill_days * 86400000;
    if (drill) await maintenance("backup-drill", { backupId: point.backup_id }, lifecycle);
    await (dependencies.prune ?? pruneBackups)(context, config, [point.backup_id], now);
    await save({ ...started, status: "succeeded", backup_id: point.backup_id, drilled: drill });
    return scheduleHealth(context, now, task);
  } catch (error) {
    const code = /^WINDOWS_COMPANION_[A-Z_]{1,80}$/u.test(error.message)
      ? error.message
      : "WINDOWS_COMPANION_BACKUP_RUN_FAILED";
    await save({ ...started, status: "failed", code });
    throw new Error(code);
  }
}

/**
 * ADR-91 D-4: an installation nobody has configured backs up daily at the default
 * 03:00, outside business hours. A saved choice, including "off", is never overridden.
 * Returns the outcome for the operator; a failure leaves installation itself intact.
 */
export async function enableDefaultSchedule(lifecycle, dependencies = {}) {
  if (await exists(join(lifecycle.root, "backup-schedule.json"))) return null;
  try {
    const health = await scheduledMaintenance(
      "backup-schedule",
      { ...DEFAULT_SCHEDULE, enabled: true },
      lifecycle,
      dependencies,
    );
    return health.config.enabled ? "enabled" : "WINDOWS_COMPANION_BACKUP_SCHEDULE_FAILED";
  } catch (error) {
    // Registration writes a disabled placeholder first; drop it so the next install,
    // repair or upgrade tries again instead of mistaking it for the owner's choice.
    const path = join(lifecycle.root, "backup-schedule.json");
    if ((await exists(path)) && !(await scheduleConfiguration(lifecycle)).enabled)
      await rm(path, { force: true });
    return /^WINDOWS_COMPANION_[A-Z_]{1,80}$/u.test(error.message)
      ? error.message
      : "WINDOWS_COMPANION_BACKUP_SCHEDULE_FAILED";
  }
}

export async function uninstallSchedule(lifecycle) {
  const config = await scheduleConfiguration(lifecycle);
  await lifecycle.io.write(
    join(lifecycle.root, "backup-schedule.json"),
    JSON.stringify({ ...config, enabled: false }),
  );
  await managedScheduleTask(lifecycle, "remove", config, scheduleTask);
  await clearScheduleController(lifecycle);
}
