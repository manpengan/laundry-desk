import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { BACKUP_ACTIONS, requireBackupOptions } from "./backup-contract.mjs";
import { DATA_ACTIONS, requireDataOptions } from "./data-options.mjs";
import { SCHEDULE_ACTIONS, requireSchedule } from "./schedule-contract.mjs";

// Execute the actual state machine with faulting OS/database boundaries. This
// keeps failure ordering testable without starting Windows processes on macOS.
const source = await readFile(new URL("./lifecycle.mjs", import.meta.url), "utf8");
const body = source.replace(/import [\s\S]*? from "[^"\n]+";\n/g, "").replace(/export /g, "");

function fixture({
  stopFailures = 0,
  startFailure = false,
  maintenance = null,
  schemaChange = false,
  phase = "running",
  scheduleResult = "enabled",
} = {}) {
  const old = { digest: "old" };
  const next = { digest: "next", ...(schemaChange ? { migrationHead: "0070_next.sql" } : {}) };
  const scheduleEvents = [];
  let state = {
    phase,
    current: old,
    previous: schemaChange ? next : null,
    controller: old,
    pending: null,
    releases: [old, next],
  };
  let postgres = "old";
  let api = "old";
  let remainingStops = stopFailures;
  const mocks = {
    process: { platform: "win32", arch: "x64", env: { LOCALAPPDATA: "C:\\User\\Local" } },
    BACKUP_ACTIONS,
    requireBackupOptions,
    DATA_ACTIONS,
    requireDataOptions,
    SCHEDULE_ACTIONS,
    requireSchedule,
    readMaintenance: async () => maintenance,
    schemaMaintenance: async (action, target, context) => {
      const committed = action !== "maintenance-recover" || maintenance.phase === "verified";
      await context.saveState({ ...state, current: committed ? target : old, phase });
      scheduleEvents.push("schema-complete");
      return { status: phase, schema_transition: action, committed };
    },
    enableDefaultSchedule: async (context) => {
      assert.equal(context.getState().phase, "running");
      assert.equal(context.getState().current.digest, "next");
      scheduleEvents.push("default-schedule");
      return scheduleResult;
    },
    backupMaintenance: async () => {
      throw new Error("UNEXPECTED_MAINTENANCE_ENTRY");
    },
    randomUUID: () => "test",
    mkdir: async () => {},
    rm: async () => {},
    rename: async () => {},
    ...Object.fromEntries(
      ["dirname", "join", "resolve", "relative", "isAbsolute"].map((key) => [key, win32[key]]),
    ),
    inspectCompanion: async () => next,
    requireRealDirectory: async () => {},
    fail: (code) => {
      throw new Error(code);
    },
    exists: async () => true,
    loadPlatform: async () => ({}),
    storage: () => ({
      directory: async () => {},
      write: async (_path, json) => {
        state = JSON.parse(json);
      },
    }),
    readState: async () => structuredClone(state),
    reference: (manifest, digest) => ({ ...manifest, digest }),
    requireCompatible: () => {},
    requireState: (value) => value,
    withOperationLock: async (_root, action) => action(),
    stageRelease: async () => {},
    verifyRelease: async (_root, entry) => ({ payload: entry.digest, manifest: {} }),
    removeBoundPrograms: async () => {},
    host: async (action, _root, payload) => {
      if (action.startsWith("task-")) return { exists: true };
      if ((postgres && postgres !== payload) || (api && api !== payload))
        throw new Error("WINDOWS_COMPANION_PROCESS_CONFLICT");
      const result = { postgres: Boolean(postgres), api: Boolean(api) };
      if (action === "stop-server") api = null;
      return result;
    },
    health: async () => {},
    pgControl: async (action, _root, payload) => {
      if (action === "start") {
        postgres = payload;
        if (payload === "next" && startFailure)
          throw new Error("WINDOWS_COMPANION_POSTGRES_START_FAILED");
      } else {
        if (payload === "next" && remainingStops > 0) {
          remainingStops -= 1;
          throw new Error("WINDOWS_COMPANION_POSTGRES_STOP_FAILED");
        }
        postgres = null;
      }
    },
    startServer: async (_root, payload) => {
      api = payload;
    },
    runtimeEnvironment: async () => ({}),
    cleanEnvironment: () => ({}),
    initializeDatabase: async () => {},
    initializeSecrets: async () => {},
    kit: async () => {},
    serverEnvironment: (value) => value,
  };
  const lifecycle = new Function(...Object.keys(mocks), `${body}\nreturn lifecycle;`)(
    ...Object.values(mocks),
  );
  return {
    run: (action) => lifecycle(action, "C:\\distribution", "next"),
    snapshot: () => ({ state: structuredClone(state), postgres, api }),
    scheduleEvents,
    allowStop: () => {
      remainingStops = 0;
    },
  };
}

function assertOldRunning(subject) {
  const { state, postgres, api } = subject.snapshot();
  assert.equal(state.current.digest, "old");
  assert.equal(state.pending, null);
  assert.equal(state.phase, "running");
  assert.equal(postgres, "old");
  assert.equal(api, "old");
}

test("candidate cleanup failure stops the candidate before restoring the old version", async () => {
  const subject = fixture({ stopFailures: 1 });
  await assert.rejects(subject.run("upgrade"), /POSTGRES_STOP_FAILED/u);
  assertOldRunning(subject);
});

test("persistent candidate stop failure preserves identity for the next invocation", async () => {
  const subject = fixture({ stopFailures: Infinity });
  await assert.rejects(subject.run("upgrade"), /POSTGRES_STOP_FAILED/u);
  const pending = subject.snapshot();
  assert.equal(pending.state.current.digest, "old");
  assert.equal(pending.state.pending.digest, "next");
  assert.equal(pending.postgres, "next");
  assert.equal(pending.api, null);
  await assert.rejects(subject.run("start"), /POSTGRES_STOP_FAILED/u);
  assert.equal(subject.snapshot().state.pending.digest, "next");
  subject.allowStop();
  await subject.run("start");
  assertOldRunning(subject);
});

test("candidate start that takes effect before throwing is cleaned up before rollback", async () => {
  const subject = fixture({ startFailure: true });
  await assert.rejects(subject.run("upgrade"), /POSTGRES_START_FAILED/u);
  assertOldRunning(subject);
});

test("pending data maintenance blocks normal startup, repair, upgrade and uninstall", async () => {
  const maintenance = { operation: "restore", phase: "switching", safety: null };
  for (const action of ["start", "repair", "install", "upgrade", "rollback", "uninstall"]) {
    const subject = fixture({ maintenance });
    await assert.rejects(subject.run(action), /MAINTENANCE_RECOVERY_REQUIRED/u);
    assert.equal(subject.snapshot().state.current.digest, "old");
  }
  assert.equal((await fixture({ maintenance }).run("status")).status, "maintenance_required");
  const subject = fixture({ maintenance });
  await subject.run("stop");
  assert.equal(subject.snapshot().api, null);
  assert.equal(subject.snapshot().postgres, null);
});

test("a running cross-schema upgrade initializes an unconfigured backup schedule after commit", async () => {
  const subject = fixture({ schemaChange: true });
  const result = await subject.run("upgrade");
  assert.equal(result.backup_schedule, "enabled");
  assert.deepEqual(subject.scheduleEvents, ["schema-complete", "default-schedule"]);
});

test("cross-schema completion preserves saved schedule choices and reports registration failure", async () => {
  for (const scheduleResult of [null, "WINDOWS_COMPANION_BACKUP_SCHEDULE_FAILED"]) {
    const subject = fixture({ schemaChange: true, scheduleResult });
    const result = await subject.run("upgrade");
    assert.equal(result.backup_schedule, scheduleResult ?? undefined);
    assert.equal(subject.snapshot().state.current.digest, "next");
    assert.equal(subject.snapshot().state.phase, "running");
  }
});

test("stopped upgrades and rollbacks do not initialize default backups", async () => {
  for (const [action, phase] of [
    ["upgrade", "stopped"],
    ["rollback", "running"],
  ]) {
    const subject = fixture({ schemaChange: true, phase });
    const result = await subject.run(action);
    assert.equal(result.backup_schedule, undefined);
    assert.deepEqual(subject.scheduleEvents, ["schema-complete"]);
  }
});

test("recovery initializes defaults only for a committed upgrade that resumes running", async () => {
  for (const operation of ["schema-upgrade", "schema-rollback"]) {
    for (const journalPhase of ["verified", "switching"]) {
      for (const phase of ["running", "stopped"]) {
        const subject = fixture({
          phase,
          maintenance: { version: 2, operation, phase: journalPhase, next: { digest: "next" } },
        });
        const result = await subject.run("maintenance-recover");
        const enabled =
          operation === "schema-upgrade" && journalPhase === "verified" && phase === "running";
        assert.equal(result.backup_schedule, enabled ? "enabled" : undefined);
        assert.deepEqual(
          subject.scheduleEvents,
          enabled ? ["schema-complete", "default-schedule"] : ["schema-complete"],
        );
      }
    }
  }
});
