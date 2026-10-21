import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { BACKUP_ACTIONS, requireBackupOptions } from "./backup-contract.mjs";
import { DATA_ACTIONS, requireDataOptions } from "./data-options.mjs";
import { SCHEDULE_ACTIONS, requireSchedule } from "./schedule-contract.mjs";
import {
  requireFreshStore,
  requireStoreInput,
  requireStoreRuntime,
} from "./store-initialization.mjs";
import { STORE_INITIALIZATION_FILES } from "./companion-contract.mjs";
import { requireStateSchema } from "./lifecycle-storage.mjs";

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
  inputCleanupFailure = false,
  stateSchema = 1,
  unsupportedSource = false,
  unsupportedEntry = null,
} = {}) {
  const old = { digest: "old" };
  const next = { digest: "next", ...(schemaChange ? { migrationHead: "0070_next.sql" } : {}) };
  const scheduleEvents = [];
  const mutations = [];
  const diagnosticContexts = [];
  let state = {
    schema: stateSchema,
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
    requireFreshStore,
    requireStoreInput,
    requireStoreRuntime,
    requireStateSchema,
    validateStoreInput: async (_payload, _manifest, value) => value,
    clearStoreInput: async () => {
      if (inputCleanupFailure)
        throw new Error(`WINDOWS_COMPANION_STORE_INPUT_CLEANUP_FAILED ${inputCleanupFailure}`);
    },
    exportDiagnosticBundle: async (context) => {
      diagnosticContexts.push(context);
      await context.probe();
      return { status: "diagnostic_exported", setup_input_cleanup: context.setupInputCleanup };
    },
    readMaintenance: async () =>
      maintenance?.version === 2
        ? { ...maintenance, old_state: maintenance.old_state ?? structuredClone(state) }
        : maintenance,
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
    inspectCompanion: async () => ({
      ...next,
      files: unsupportedSource ? [] : STORE_INITIALIZATION_FILES.map((path) => ({ path })),
    }),
    requireRealDirectory: async () => {},
    fail: (code) => {
      throw new Error(code);
    },
    exists: async () => true,
    loadPlatform: async () => ({}),
    storage: () => ({
      directory: async () => {},
      write: async (_path, json) => {
        mutations.push("save-state");
        state = JSON.parse(json);
      },
    }),
    readState: async () => structuredClone(state),
    reference: (manifest, digest) => ({ ...manifest, digest }),
    requireCompatible: () => {},
    requireState: (value) => value,
    withOperationLock: async (_root, action) => action(),
    stageRelease: async () => {
      mutations.push("stage-release");
    },
    verifyRelease: async (_root, entry) => ({
      payload: entry.digest,
      manifest: {
        files:
          entry.digest === unsupportedEntry
            ? []
            : STORE_INITIALIZATION_FILES.map((path) => ({ path })),
      },
    }),
    removeBoundPrograms: async () => {},
    host: async (action, _root, payload) => {
      if (!["ports", "task-inspect"].includes(action)) mutations.push(action);
      if (action.startsWith("task-")) return { exists: true };
      if ((postgres && postgres !== payload) || (api && api !== payload))
        throw new Error("WINDOWS_COMPANION_PROCESS_CONFLICT");
      const result = { postgres: Boolean(postgres), api: Boolean(api) };
      if (action === "stop-server") api = null;
      return result;
    },
    health: async () => {},
    pgControl: async (action, _root, payload) => {
      mutations.push(`postgres-${action}`);
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
      mutations.push("start-server");
      api = payload;
    },
    runtimeEnvironment: async () => ({}),
    cleanEnvironment: () => ({}),
    installFreshRuntime: async () => assert.fail("existing instance entered fresh installation"),
    kit: async () => {},
    serverEnvironment: (value) => value,
  };
  const lifecycle = new Function(...Object.keys(mocks), `${body}\nreturn lifecycle;`)(
    ...Object.values(mocks),
  );
  return {
    run: (action, options) => lifecycle(action, "C:\\distribution", "next", options),
    snapshot: () => ({ state: structuredClone(state), postgres, api }),
    scheduleEvents,
    mutations,
    diagnosticContexts,
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

test("install-store refuses a live QA root before staging, stopping, credential access or task changes", async () => {
  const subject = fixture({ inputCleanupFailure: true });
  const before = subject.snapshot();
  await assert.rejects(
    subject.run("install-store", {
      version: 1,
      mode: "new_empty",
      admin: {
        username: "synthetic-owner",
        displayName: "Owner",
        password: "Synthetic-owner-only",
        pin: "123456",
      },
      approver: {
        username: "synthetic-reviewer",
        displayName: "Reviewer",
        password: "Synthetic-reviewer-only",
        pin: "654321",
      },
    }),
    /STORE_REQUIRES_NEW_INSTANCE/u,
  );
  assert.deepEqual(subject.snapshot(), before);
  assert.deepEqual(subject.scheduleEvents, []);
});

test("a private input cleanup error blocks startup but still permits an explicit identity-checked stop", async () => {
  const subject = fixture({ inputCleanupFailure: true });
  await assert.rejects(subject.run("start"), /STORE_INPUT_CLEANUP_FAILED/u);
  assertOldRunning(subject);
  await assert.rejects(subject.run("stop"), /STORE_INPUT_CLEANUP_FAILED/u);
  assert.equal(subject.snapshot().api, null);
  assert.equal(subject.snapshot().postgres, null);
  assert.equal(subject.snapshot().state.current.digest, "old");
  assert.deepEqual(subject.scheduleEvents, []);
});

test("cleanup failure keeps staged and running diagnostics available without service or state changes", async () => {
  const secret = "private-password-C:\\private-input\\unknown.txt";
  for (const phase of ["staged", "running"]) {
    const subject = fixture({ phase, inputCleanupFailure: secret });
    const before = subject.snapshot();
    const result = await subject.run("diagnostics");
    assert.equal(result.status, "diagnostic_exported");
    assert.equal(result.setup_input_cleanup, "failed");
    assert.deepEqual(subject.snapshot(), before);
    assert.deepEqual(subject.mutations, []);
    assert.deepEqual(subject.scheduleEvents, []);
    assert.equal(subject.diagnosticContexts.length, 1);
    assert.equal(JSON.stringify(subject.diagnosticContexts[0]).includes(secret), false);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test("operator instances refuse legacy source and rollback targets before staging or service changes", async () => {
  for (const action of ["install", "repair", "upgrade", "start"]) {
    const subject = fixture({ stateSchema: 2, unsupportedSource: true });
    const before = subject.snapshot();
    await assert.rejects(subject.run(action), /STORE_RUNTIME_VERSION_REQUIRED/u);
    assert.deepEqual(subject.snapshot(), before);
    assert.deepEqual(subject.mutations, []);
  }
  for (const [action, options] of [
    ["rollback", { schemaChange: true, unsupportedEntry: "next" }],
    ["stop", { unsupportedEntry: "old" }],
  ]) {
    const subject = fixture({ stateSchema: 2, ...options });
    const before = subject.snapshot();
    await assert.rejects(subject.run(action), /STORE_RUNTIME_VERSION_REQUIRED/u);
    assert.deepEqual(subject.snapshot(), before);
    assert.deepEqual(subject.mutations, []);
  }
});

test("operator state remains version two through supported upgrade, rollback and restart", async () => {
  const subject = fixture({ stateSchema: 2 });
  for (const action of ["upgrade", "rollback", "stop", "start"]) {
    await subject.run(action);
    assert.equal(subject.snapshot().state.schema, 2);
  }
  assertOldRunning(subject);
});

test("a recovery journal cannot downgrade an operator instance before recovery begins", async () => {
  const subject = fixture({
    stateSchema: 2,
    maintenance: {
      version: 2,
      operation: "schema-upgrade",
      phase: "verified",
      old_state: { schema: 1 },
    },
  });
  const before = subject.snapshot();
  await assert.rejects(subject.run("maintenance-recover"), /STATE_SCHEMA_CHANGE_REJECTED/u);
  assert.deepEqual(subject.snapshot(), before);
  assert.deepEqual(subject.mutations, []);
  assert.deepEqual(subject.scheduleEvents, []);
});

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
