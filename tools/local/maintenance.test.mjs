import assert from "node:assert/strict";
import { mkdtemp, mkdir, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { LocalDataError } from "./data-tools.mjs";
import { runMaintenance, parseMaintenanceArguments } from "./maintenance.mjs";
import {
  inspectMaintenanceHealth,
  rotateRecoverySets,
  updateMaintenanceState,
  withMaintenanceLock,
} from "./maintenance-state.mjs";
import { parseRestoreDrillArguments, runRestoreDrill } from "./restore-drill.mjs";

const roots = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function backupDirectory() {
  const root = await mkdtemp(join(tmpdir(), "laundry-maintenance-"));
  roots.push(root);
  const path = join(root, "backups");
  await mkdir(path, { mode: 0o700 });
  return path;
}

test("maintenance CLI is bounded and retention deletion is explicit", () => {
  assert.deepEqual(parseMaintenanceArguments([]), {
    applyRetention: false,
    retentionDays: 30,
    maxBackups: 30,
  });
  assert.deepEqual(
    parseMaintenanceArguments([
      "--retention-days",
      "14",
      "--max-backups",
      "10",
      "--apply-retention",
    ]),
    { applyRetention: true, retentionDays: 14, maxBackups: 10 },
  );
  assert.throws(
    () => parseMaintenanceArguments(["--max-backups", "0"]),
    /LOCAL_MAINTENANCE_ARGS_INVALID/u,
  );
  assert.throws(
    () => parseRestoreDrillArguments(["--file", "/tmp/x"]),
    /LOCAL_RESTORE_DRILL_ARGS_INVALID/u,
  );
});

test("maintenance lock rejects a concurrent backup and is released after completion", async () => {
  const directory = await backupDirectory();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let acquired;
  const lockAcquired = new Promise((resolve) => {
    acquired = resolve;
  });
  const first = withMaintenanceLock(directory, "backup", async () => {
    acquired();
    await held;
    return "done";
  });
  await lockAcquired;
  await assert.rejects(
    () => withMaintenanceLock(directory, "restore-drill", async () => undefined),
    /LOCAL_MAINTENANCE_BUSY/u,
  );
  release();
  assert.equal(await first, "done");
  assert.equal(await withMaintenanceLock(directory, "restore-drill", async () => "next"), "next");
});

test("maintenance health distinguishes fresh, stale and failed state", async () => {
  const directory = await backupDirectory();
  assert.deepEqual(await inspectMaintenanceHealth(directory), { ok: false, status: "missing" });
  await updateMaintenanceState(directory, {
    last_backup: {
      status: "ok",
      completed_at: "2026-07-30T00:00:00.000Z",
      file: "laundry-v2-backup-20260730T000000Z-aaaaaaaa.dump",
      sha256: "a".repeat(64),
    },
    last_failure: null,
  });
  assert.equal(
    (
      await inspectMaintenanceHealth(directory, {
        now: new Date("2026-07-30T01:00:00.000Z"),
        maxAgeSeconds: 7200,
      })
    ).status,
    "healthy",
  );
  assert.equal(
    (
      await inspectMaintenanceHealth(directory, {
        now: new Date("2026-07-31T03:00:00.000Z"),
        maxAgeSeconds: 26 * 60 * 60,
      })
    ).status,
    "stale",
  );
  await updateMaintenanceState(directory, {
    last_failure: {
      operation: "backup",
      code: "LOCAL_BACKUP_DUMP_FAILED",
      failed_at: "2026-07-31T04:00:00.000Z",
    },
  });
  assert.equal(
    (
      await inspectMaintenanceHealth(directory, {
        now: new Date("2026-07-31T04:01:00.000Z"),
        maxAgeSeconds: 26 * 60 * 60,
      })
    ).status,
    "failed",
  );
});

test("retention dry-run never deletes and apply skips newest and corrupt sets", async () => {
  const directory = await backupDirectory();
  const context = Object.freeze({ backupDirectory: directory });
  const sets = Object.freeze([
    Object.freeze({
      name: "laundry-v2-backup-20260730T030000Z-aaaaaaaa.dump",
      path: join(directory, "laundry-v2-backup-20260730T030000Z-aaaaaaaa.dump"),
      created_at_ms: Date.parse("2026-07-30T03:00:00Z"),
      verified: Object.freeze({}),
    }),
    Object.freeze({
      name: "laundry-v2-backup-20260601T030000Z-bbbbbbbb.dump",
      path: join(directory, "laundry-v2-backup-20260601T030000Z-bbbbbbbb.dump"),
      created_at_ms: Date.parse("2026-06-01T03:00:00Z"),
      verified: Object.freeze({}),
    }),
    Object.freeze({
      name: "laundry-v2-backup-20260501T030000Z-cccccccc.dump",
      path: join(directory, "laundry-v2-backup-20260501T030000Z-cccccccc.dump"),
      created_at_ms: Date.parse("2026-05-01T03:00:00Z"),
      verified: null,
    }),
  ]);
  const removed = [];
  const dependencies = Object.freeze({
    lstat: async (path) =>
      Object.freeze({
        isSymbolicLink: () => false,
        isDirectory: () => path.endsWith(".photos"),
      }),
    rm: async (path) => removed.push(path),
  });
  const dryRun = await rotateRecoverySets(
    context,
    sets,
    {
      apply: false,
      retentionDays: 30,
      maxBackups: 30,
      now: new Date("2026-07-30T04:00:00Z"),
    },
    dependencies,
  );
  assert.deepEqual(dryRun.candidates, [sets[1].name]);
  assert.deepEqual(dryRun.corrupt, [sets[2].name]);
  assert.deepEqual(removed, []);

  await rotateRecoverySets(
    context,
    sets,
    {
      apply: true,
      retentionDays: 30,
      maxBackups: 30,
      now: new Date("2026-07-30T04:00:00Z"),
    },
    dependencies,
  );
  assert.equal(removed.length, 4);
  assert.ok(removed.every((path) => path.includes(sets[1].name)));
});

test("retention always preserves the newest verified set when a newer set is corrupt", async () => {
  const directory = await backupDirectory();
  const corrupt = Object.freeze({
    name: "laundry-v2-backup-20260730T030000Z-aaaaaaaa.dump",
    path: join(directory, "laundry-v2-backup-20260730T030000Z-aaaaaaaa.dump"),
    created_at_ms: Date.parse("2026-07-30T03:00:00Z"),
    verified: null,
  });
  const onlyVerified = Object.freeze({
    name: "laundry-v2-backup-20260501T030000Z-bbbbbbbb.dump",
    path: join(directory, "laundry-v2-backup-20260501T030000Z-bbbbbbbb.dump"),
    created_at_ms: Date.parse("2026-05-01T03:00:00Z"),
    verified: Object.freeze({}),
  });
  const result = await rotateRecoverySets(
    Object.freeze({ backupDirectory: directory }),
    Object.freeze([corrupt, onlyVerified]),
    {
      apply: true,
      retentionDays: 1,
      maxBackups: 1,
      now: new Date("2026-07-30T04:00:00Z"),
    },
    Object.freeze({
      lstat: async () => {
        throw new Error("the protected recovery set must not be inspected for deletion");
      },
      rm: async () => {
        throw new Error("the protected recovery set must not be deleted");
      },
    }),
  );
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.corrupt, [corrupt.name]);
  assert.equal(result.retained, 2);
});

test("scheduled maintenance restarts the server and records a dry-run rotation", async () => {
  const directory = await backupDirectory();
  const calls = [];
  const backup = Object.freeze({
    path: join(directory, "laundry-v2-backup-20260730T030000Z-aaaaaaaa.dump"),
    sha256: "a".repeat(64),
  });
  const dependencies = Object.freeze({
    now: () => new Date("2026-07-30T03:00:00.000Z"),
    prepareLocalDataContext: async () =>
      Object.freeze({
        project: "laundry-ci-test",
        env: Object.freeze({ PATH: "/bin" }),
        backupDirectory: directory,
      }),
    withMaintenanceLock: async (_directory, _operation, callback) => callback(),
    run: async (command) => calls.push(command.args.includes("stop") ? "stop" : "up"),
    createDisasterRecoveryBackup: async () => backup,
    listRecoverySets: async () => Object.freeze([]),
    rotateRecoverySets: async (_context, _sets, options) => {
      assert.equal(options.apply, false);
      return Object.freeze({ mode: "dry-run", retained: 1, candidates: [], corrupt: [] });
    },
    updateMaintenanceState: async (_directory, patch) => {
      calls.push(patch.last_backup === undefined ? "failure" : "state");
    },
  });
  const result = await runMaintenance(
    { argv: [], env: Object.freeze({}), cwd: "/workspace", stdout: () => undefined },
    dependencies,
  );
  assert.equal(result.rotation.mode, "dry-run");
  assert.deepEqual(calls, ["stop", "up", "state"]);
});

test("restore drill uses a shadow database and drops it after validation", async () => {
  const directory = await backupDirectory();
  const sourcePath = join(directory, "laundry-v2-backup-20260730T030000Z-aaaaaaaa.dump");
  await writeFile(sourcePath, "private-dump", { mode: 0o600 });
  const calls = [];
  const dependencies = Object.freeze({
    now: () => new Date("2026-07-30T04:00:00.000Z"),
    randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    prepareLocalDataContext: async () =>
      Object.freeze({
        project: "laundry-ci-test",
        env: Object.freeze({ PATH: "/bin" }),
        backupDirectory: directory,
      }),
    withMaintenanceLock: async (_directory, _operation, callback) => callback(),
    verifyBackup: async () => Object.freeze({ path: sourcePath }),
    open,
    run: async (command) => calls.push(command.args.includes("createdb") ? "create" : "drop"),
    stream: async () => calls.push("restore"),
    capture: async () => {
      calls.push("validate");
      return "DRILL_OK\n";
    },
    updateMaintenanceState: async () => calls.push("state"),
  });
  const result = await runRestoreDrill(
    {
      argv: ["--file", sourcePath, "--confirm-sha256", "a".repeat(64)],
      env: Object.freeze({}),
      cwd: "/workspace",
      stdout: () => undefined,
    },
    dependencies,
  );
  assert.equal(result.status, "ok");
  assert.deepEqual(calls, ["create", "restore", "validate", "drop", "state"]);
});

test("restore drill records failure when shadow database cleanup fails", async () => {
  const directory = await backupDirectory();
  const sourcePath = join(directory, "laundry-v2-backup-20260730T030000Z-aaaaaaaa.dump");
  await writeFile(sourcePath, "private-dump", { mode: 0o600 });
  const statePatches = [];
  await assert.rejects(
    () =>
      runRestoreDrill(
        {
          argv: ["--file", sourcePath, "--confirm-sha256", "a".repeat(64)],
          env: Object.freeze({}),
          cwd: "/workspace",
          stdout: () => undefined,
        },
        Object.freeze({
          now: () => new Date("2026-07-30T04:00:00.000Z"),
          randomUUID: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          prepareLocalDataContext: async () =>
            Object.freeze({
              project: "laundry-ci-test",
              env: Object.freeze({ PATH: "/bin" }),
              backupDirectory: directory,
            }),
          withMaintenanceLock: async (_directory, _operation, callback) => callback(),
          verifyBackup: async () => Object.freeze({ path: sourcePath }),
          open,
          run: async (command) => {
            if (command.args.includes("dropdb")) throw new Error("drop failed");
          },
          stream: async () => undefined,
          capture: async () => "DRILL_OK\n",
          updateMaintenanceState: async (_directory, patch) => statePatches.push(patch),
        }),
      ),
    /drop failed/u,
  );
  assert.equal(statePatches.length, 1);
  assert.equal(statePatches[0]?.last_drill, undefined);
  assert.equal(statePatches[0]?.last_failure?.operation, "restore-drill");
});

test("restore drill does not touch PostgreSQL when recovery verification fails", async () => {
  const directory = await backupDirectory();
  let called = false;
  await assert.rejects(
    () =>
      runRestoreDrill(
        {
          argv: ["/bad"],
          env: Object.freeze({}),
          cwd: "/workspace",
          stdout: () => undefined,
        },
        Object.freeze({
          prepareLocalDataContext: async () => {
            called = true;
          },
        }),
      ),
    (error) => error instanceof LocalDataError,
  );
  assert.equal(called, false);
  assert.ok(directory.length > 0);
});
