import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { win32 } from "node:path";

// Execute the actual state machine with faulting OS/database boundaries. This
// keeps failure ordering testable without starting Windows processes on macOS.
const source = await readFile(new URL("./lifecycle.mjs", import.meta.url), "utf8");
const body = source.replace(/import [\s\S]*? from "[^"\n]+";\n/g, "").replace(/export /g, "");

function fixture({ stopFailures = 0, startFailure = false } = {}) {
  const old = { digest: "old" };
  const next = { digest: "next" };
  let state = {
    phase: "running",
    current: old,
    previous: null,
    controller: old,
    pending: null,
    releases: [old, next],
  };
  let postgres = "old";
  let api = "old";
  let remainingStops = stopFailures;
  const mocks = {
    process: { platform: "win32", arch: "x64", env: { LOCALAPPDATA: "C:\\User\\Local" } },
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
    reference: (_manifest, digest) => ({ digest }),
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
