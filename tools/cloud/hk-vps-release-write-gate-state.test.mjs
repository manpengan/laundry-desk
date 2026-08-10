import assert from "node:assert/strict";
import test from "node:test";

import { releaseControllerPath } from "./hk-vps-release-controller-contract.mjs";
import { createTransition, updateTransition } from "./hk-vps-release-remote-support.mjs";
import {
  activatePersistedRecoveryWriteGate,
  persistWriteGateIntent,
  releasePersistedWriteGate,
} from "./hk-vps-release-write-gate-state.mjs";

const CANDIDATE = "a".repeat(40);
const EXPECTED = "b".repeat(40);
const TOKEN = "c".repeat(32);

function transition() {
  return createTransition({
    archiveDigest: "1".repeat(64),
    candidateSha: CANDIDATE,
    controllerDigest: "2".repeat(64),
    controllerPath: releaseControllerPath(CANDIDATE, TOKEN),
    expectedSha: EXPECTED,
    migrationHead: "0046_cloud_primary.sql",
    token: TOKEN,
  });
}

test("write gate intent is durable before NOLOGIN can be attempted", async () => {
  const events = [];
  const result = await persistWriteGateIntent(transition(), undefined, {
    inspectWriteGate: async () => events.push("inspect"),
    persistTransition: async (record) => events.push(`persist:${record.write_gate_state}`),
  });
  assert.deepEqual(events, ["inspect", "persist:intent"]);
  assert.equal(result.app_role_original_can_login, true);
  assert.equal(result.write_gate_state, "intent");
});

test("write gate release is idempotent for intent, active, and released records", async () => {
  for (const state of ["intent", "active", "released"]) {
    const events = [];
    const record = updateTransition(transition(), {
      app_role_original_can_login: true,
      write_gate_state: state,
    });
    const result = await releasePersistedWriteGate(record, undefined, {
      persistTransition: async (next) => events.push(`persist:${next.write_gate_state}`),
      releaseWriteGate: async () => events.push("login"),
    });
    assert.deepEqual(events, ["login", "persist:released"]);
    assert.equal(result.write_gate_state, "released");
  }
});

test("write gate release retries safely when LOGIN succeeded but state persistence was lost", async () => {
  const record = updateTransition(transition(), {
    app_role_original_can_login: true,
    write_gate_state: "active",
  });
  let loginCalls = 0;
  await assert.rejects(
    () =>
      releasePersistedWriteGate(record, undefined, {
        persistTransition: async () => {
          throw new Error("released fsync failed");
        },
        releaseWriteGate: async () => {
          loginCalls += 1;
        },
      }),
    /released fsync failed/u,
  );
  const retried = await releasePersistedWriteGate(record, undefined, {
    persistTransition: async () => undefined,
    releaseWriteGate: async () => {
      loginCalls += 1;
    },
  });
  assert.equal(loginCalls, 2);
  assert.equal(retried.write_gate_state, "released");
});

test("write gate release leaves a never-intended transition unchanged", async () => {
  const record = transition();
  const result = await releasePersistedWriteGate(record, undefined, {
    persistTransition: async () => assert.fail("must not persist"),
    releaseWriteGate: async () => assert.fail("must not alter role"),
  });
  assert.equal(result, record);
});

test("incompatible recovery persists intent before restoring NOLOGIN authority", async () => {
  const events = [];
  const record = updateTransition(transition(), {
    app_role_original_can_login: true,
    phase: "recovery_required",
    write_gate_state: "released",
  });
  const result = await activatePersistedRecoveryWriteGate(record, undefined, {
    activateWriteGate: async () => events.push("nologin"),
    persistTransition: async (next) => events.push(`persist:${next.write_gate_state}`),
  });
  assert.deepEqual(events, ["persist:intent", "nologin", "persist:active"]);
  assert.equal(result.write_gate_state, "active");
});
