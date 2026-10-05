import assert from "node:assert/strict";
import { readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { backupFixture } from "./backup-test-fixture.mjs";
import { createBackup } from "./backup-files.mjs";
import { DEFAULT_SCHEDULE, requireSchedule } from "./schedule-contract.mjs";
import {
  enableDefaultSchedule,
  recordOffsiteExport,
  scheduledMaintenance,
  scheduleConfiguration,
} from "./schedule-maintenance.mjs";
import { pruneBackups } from "./schedule-retention.mjs";
import { resumePruning } from "./schedule-prune.mjs";
import { managedScheduleTask } from "./schedule-controller.mjs";

async function fixture(t) {
  const context = await backupFixture(t),
    events = [];
  const lifecycle = {
    ...context,
    getState: () => ({
      phase: "running",
      pending: null,
      current: context.entry,
      releases: [context.entry],
    }),
    verify: async () => ({
      payload: context.root,
      manifest: {
        sources: { postgres: { version: "16.15" } },
        files: [{ path: "scripts/schedule-task.ps1" }],
      },
    }),
  };
  const config = { ...DEFAULT_SCHEDULE, enabled: true };
  await context.io.write(join(context.root, "backup-schedule.json"), JSON.stringify(config));
  const deps = {
    task: async () => ({ exists: true }),
    now: () => Date.parse("2026-10-03T08:00:00.000Z"),
    available: async () => 10000,
    prune: async () => {
      events.push("prune");
    },
    backupMaintenance: async (action, options) => {
      events.push(action);
      if (action === "backup-drill") assert.equal(options.backupId, `b_${"a".repeat(32)}`);
      return { backup_id: `b_${"a".repeat(32)}` };
    },
  };
  return { context, lifecycle, events, config, deps };
}
test("scheduled backups retain a private result and run due shadow drills", async (t) => {
  const f = await fixture(t);
  const result = await scheduledMaintenance("scheduled-backup", {}, f.lifecycle, f.deps);
  assert.deepEqual(f.events, ["prune", "backup", "backup-drill", "prune"]);
  assert.equal(result.latest.status, "succeeded");
  assert.equal(result.latest.drilled, true);
  f.events.length = 0;
  await scheduledMaintenance("scheduled-backup", {}, f.lifecycle, f.deps);
  assert.deepEqual(f.events, ["prune", "backup", "prune"]);
});
test("low space and backup failures persist only stable alert codes", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    scheduledMaintenance("scheduled-backup", {}, f.lifecycle, {
      ...f.deps,
      available: async () => 1,
    }),
    /BACKUP_SPACE_INSUFFICIENT/,
  );
  assert.deepEqual(f.events, []);
  await assert.rejects(
    scheduledMaintenance("scheduled-backup", {}, f.lifecycle, {
      ...f.deps,
      backupMaintenance: async () => {
        throw new Error("private-url-or-password");
      },
    }),
    /BACKUP_RUN_FAILED/,
  );
  const text = await readFile(join(f.context.root, "backup-history.json"), "utf8");
  assert.equal(text.includes("private-url"), false);
  assert.equal(JSON.parse(text).at(-1).status, "failed");
});
test("failed native task registration leaves automatic mutation disabled", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    scheduledMaintenance("backup-schedule", f.config, f.lifecycle, {
      task: async () => {
        throw new Error("registration failed");
      },
    }),
  );
  assert.equal((await scheduleConfiguration(f.context)).enabled, false);
  for (const patch of [{ hour: 24 }, { retain_count: 1 }, { command: "arbitrary" }])
    assert.throws(() => requireSchedule({ ...f.config, ...patch }), /BACKUP_SCHEDULE_INVALID/);
});
test("retention protects journal references and the newest two verified backups", async (t) => {
  const f = await fixture(t),
    points = [];
  for (let n = 0; n < 5; n++) {
    const point = await createBackup(f.context, (file) => file.writeFile(`dump-${n}`));
    await f.context.io.write(
      join(f.context.root, "backups", point.id, "backup.json"),
      JSON.stringify({
        ...point.manifest,
        created_at: new Date(Date.UTC(2026, 8, n + 1)).toISOString(),
      }),
    );
    points.push(point);
  }
  await f.context.io.write(
    join(f.context.root, "maintenance.json"),
    JSON.stringify({
      version: 1,
      operation: "backup",
      phase: "prepared",
      was_running: false,
      release: f.context.entry,
      target: null,
      safety: { id: points[0].id, digest: points[0].digest },
      candidate: null,
    }),
  );
  const result = await pruneBackups(f.context, { ...f.config, retain_count: 2, retain_days: 1 });
  assert.equal(result.removed, 2);
  assert.deepEqual(
    (await readdir(join(f.context.root, "backups"))).sort(),
    [points[0].id, points[3].id, points[4].id].sort(),
  );
});

test("interrupted retention resumes only its bound remaining inventory", async (t) => {
  const f = await fixture(t);
  const point = await createBackup(f.context, (file) => file.writeFile("retired dump"));
  const path = join(f.context.root, "backups", point.id);
  await f.context.io.write(
    join(f.context.root, "backup-prune.json"),
    JSON.stringify({ version: 1, id: point.id, manifest_sha256: point.digest }),
  );
  await unlink(join(path, "database.dump"));
  await resumePruning(f.context);
  assert.deepEqual(await readdir(join(f.context.root, "backups")), []);
  assert.deepEqual(JSON.parse(await readFile(join(f.context.root, "backup-prune.json"), "utf8")), {
    version: 1,
    phase: "idle",
  });
});

test("task controller remains the verified retained release across business-program rollback", async (t) => {
  const f = await fixture(t),
    controller = f.context.entry;
  const old = { ...controller, digest: "d".repeat(64) };
  const tasks = [];
  const task = async (context, verb) => {
    tasks.push([context.entry.digest, verb]);
    return { exists: true };
  };
  await managedScheduleTask(f.lifecycle, "register", f.config, task);
  const lifecycle = {
    ...f.lifecycle,
    getState: () => ({ current: old, releases: [old, controller] }),
    verify: async (entry) => {
      assert.equal(entry.digest, controller.digest);
      return f.lifecycle.verify(entry);
    },
  };
  await managedScheduleTask(lifecycle, "inspect", f.config, task);
  assert.deepEqual(tasks, [
    [controller.digest, "register"],
    [controller.digest, "inspect"],
  ]);
  await assert.rejects(
    managedScheduleTask(
      { ...lifecycle, getState: () => ({ current: old, releases: [old] }) },
      "remove",
      f.config,
      task,
    ),
    /CONTROLLER_INVALID/,
  );
});

test("pending upgrade or interrupted maintenance blocks scheduling before pruning or service mutation", async (t) => {
  const f = await fixture(t);
  const lifecycle = {
    ...f.lifecycle,
    getState: () => ({ ...f.lifecycle.getState(), pending: f.context.entry }),
  };
  await assert.rejects(
    scheduledMaintenance("scheduled-backup", {}, lifecycle, f.deps),
    /MAINTENANCE_RECOVERY_REQUIRED/,
  );
  assert.deepEqual(f.events, []);
  await assert.rejects(
    scheduledMaintenance("backup-schedule", f.config, lifecycle, f.deps),
    /MAINTENANCE_RECOVERY_REQUIRED/,
  );
});

test("an unconfigured installation gets the default daily backup; a saved choice is kept", async (t) => {
  const f = await fixture(t);
  const path = join(f.context.root, "backup-schedule.json");
  await unlink(path);
  const failing = { ...f.deps, task: async () => fail("WINDOWS_COMPANION_TASK_SCHEDULER_FAILED") };
  assert.equal(
    await enableDefaultSchedule(f.lifecycle, failing),
    "WINDOWS_COMPANION_TASK_SCHEDULER_FAILED",
  );
  // A failed registration leaves no placeholder, so the next repair tries again.
  await assert.rejects(readFile(path, "utf8"), /ENOENT/u);
  assert.equal(await enableDefaultSchedule(f.lifecycle, f.deps), "enabled");
  const saved = await scheduleConfiguration(f.context);
  assert.deepEqual(saved, { ...DEFAULT_SCHEDULE, enabled: true });
  assert.equal(saved.hour, 3);
  await f.context.io.write(path, JSON.stringify({ ...DEFAULT_SCHEDULE, enabled: false }));
  assert.equal(await enableDefaultSchedule(f.lifecycle, f.deps), null);
  assert.equal((await scheduleConfiguration(f.context)).enabled, false);
});

test("backup health reminds about an off-machine copy until one is recent", async (t) => {
  const f = await fixture(t);
  const health = () => scheduledMaintenance("backup-health", {}, f.lifecycle, f.deps);
  assert.equal((await health()).alerts.includes("offsite_overdue"), true);
  await recordOffsiteExport(f.context);
  assert.equal((await health()).alerts.includes("offsite_overdue"), false);
  await recordOffsiteExport(f.context, Date.now() - 8 * 86400000);
  assert.equal((await health()).alerts.includes("offsite_overdue"), true);
});

function fail(code) {
  throw new Error(code);
}
test("health includes verified manual backup and drill timestamps without private paths", async (t) => {
  const f = await fixture(t);
  const { recordBackupHealth } = await import("./backup-health-record.mjs");
  const { scheduleHealth } = await import("./schedule-maintenance.mjs");
  const now = Date.parse("2026-10-06T00:00:00.000Z");
  await recordBackupHealth(f.context, "backup-drill", now - 1000);
  await recordOffsiteExport(f.context, now - 2000);
  await managedScheduleTask(f.lifecycle, "register", f.config, f.deps.task);
  const health = await scheduleHealth(f.lifecycle, now, f.deps.task);
  assert.equal(health.last_backup_at, "2026-10-05T23:59:59.000Z");
  assert.equal(health.last_drill_at, "2026-10-05T23:59:59.000Z");
  assert.equal(health.last_offsite_at, "2026-10-05T23:59:58.000Z");
  assert.ok(Date.parse(health.next_backup_at) > now);
  assert.equal(health.alerts.includes("backup_overdue"), false);
  assert.equal(health.alerts.includes("drill_overdue"), false);
  await f.context.io.write(
    join(f.context.root, "backup-schedule.json"),
    JSON.stringify({ ...f.config, enabled: false }),
  );
  const disabled = await scheduleHealth(f.lifecycle, now, f.deps.task);
  assert.equal(disabled.next_backup_at, null);
  assert.ok(disabled.alerts.includes("backup_disabled"));
});
