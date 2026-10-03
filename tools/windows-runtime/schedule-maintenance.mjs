import { statfs } from "node:fs/promises";
import { join } from "node:path";
import { digest, fail } from "./companion-contract.mjs";
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
  const alerts = [];
  if (config.enabled) {
    try {
      if (!(await managedScheduleTask(context, "inspect", config, task)).exists)
        alerts.push("task_missing");
    } catch {
      alerts.push("task_unavailable");
    }
  }
  if (free < config.minimum_free_mib) alerts.push("low_space");
  if (latest && latest.status !== "succeeded")
    alerts.push(latest.status === "started" ? "interrupted" : "last_run_failed");
  if (config.enabled && (!success || now - Date.parse(success.at) > 2 * 86400000))
    alerts.push("backup_overdue");
  if (config.enabled && (!drill || now - Date.parse(drill.at) > config.drill_days * 86400000))
    alerts.push("drill_overdue");
  return {
    status: "backup_health",
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

export async function uninstallSchedule(lifecycle) {
  const config = await scheduleConfiguration(lifecycle);
  await lifecycle.io.write(
    join(lifecycle.root, "backup-schedule.json"),
    JSON.stringify({ ...config, enabled: false }),
  );
  await managedScheduleTask(lifecycle, "remove", config, scheduleTask);
  await clearScheduleController(lifecycle);
}
