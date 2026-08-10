import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTIVATE_WRITE_GATE_SQL,
  INSPECT_WRITE_GATE_SQL,
  RELEASE_WRITE_GATE_SQL,
  VERIFY_WRITE_GATE_SQL,
  activateDatabaseWriteGate,
  inspectDatabaseWriteGate,
  parseWriteGateActivation,
  parseWriteGateRole,
  releaseDatabaseWriteGate,
} from "./hk-vps-release-write-gate.mjs";

test("write gate role parser requires the original LOGIN, non-privileged application role", () => {
  assert.deepEqual(parseWriteGateRole("t\tf\tf\n", true), {
    bypassRls: false,
    canLogin: true,
    superuser: false,
  });
  assert.deepEqual(parseWriteGateRole("f\tf\tf\n", false), {
    bypassRls: false,
    canLogin: false,
    superuser: false,
  });
  for (const invalid of ["", "t\tt\tf\n", "t\tf\tt\n", "f\tf\tf\n", "t\tf\tf\nextra"]) {
    assert.throws(() => parseWriteGateRole(invalid, true), {
      code: "CLOUD_RELEASE_WRITE_GATE_ROLE_INVALID",
    });
  }
});

test("write gate activation parser requires every application session terminated", () => {
  assert.deepEqual(parseWriteGateActivation("2\t2\n", "0\tf\tf\tf\n"), {
    terminatedSessions: 2,
  });
  for (const invalid of [
    ["2\t1\n", "1\tf\tf\tf\n"],
    ["2\t2\n", "1\tf\tf\tf\n"],
    ["2\t2\n", "0\tt\tf\tf\n"],
    ["2\t2\n", "0\tf\tt\tf\n"],
  ]) {
    assert.throws(() => parseWriteGateActivation(...invalid), {
      code: "CLOUD_RELEASE_WRITE_GATE_ACTIVATION_INVALID",
    });
  }
});

test("write gate commands use fixed postgres SQL, clean environment, and idempotent LOGIN", async () => {
  const calls = [];
  const runCloudCommand = async (file, arguments_, options) => {
    calls.push({ arguments_, file, options });
    const sql = arguments_.at(-1);
    if (sql === ACTIVATE_WRITE_GATE_SQL) return { stdout: "1\t1\n" };
    if (sql === VERIFY_WRITE_GATE_SQL) return { stdout: "0\tf\tf\tf\n" };
    return { stdout: "t\tf\tf\n" };
  };
  await inspectDatabaseWriteGate(undefined, { runCloudCommand });
  await activateDatabaseWriteGate(undefined, { runCloudCommand });
  await releaseDatabaseWriteGate(undefined, { runCloudCommand });
  assert.equal(calls.length, 4);
  assert.deepEqual(
    calls.map((call) => call.options.label),
    [
      "CLOUD_RELEASE_WRITE_GATE_INSPECT",
      "CLOUD_RELEASE_WRITE_GATE_ACTIVATE",
      "CLOUD_RELEASE_WRITE_GATE_VERIFY",
      "CLOUD_RELEASE_WRITE_GATE_RELEASE",
    ],
  );
  for (const call of calls) {
    assert.equal(call.file, "/usr/bin/sudo");
    assert.deepEqual(call.arguments_.slice(0, 4), ["-u", "postgres", "--", "/usr/bin/psql"]);
    assert.ok(call.arguments_.includes("--quiet"));
    assert.ok(call.arguments_.includes("--set=ON_ERROR_STOP=1"));
    assert.deepEqual(Object.keys(call.options.environment).sort(), ["LANG", "LC_ALL", "PATH"]);
  }
  assert.match(ACTIVATE_WRITE_GATE_SQL, /ALTER ROLE laundry_app NOLOGIN/u);
  assert.match(ACTIVATE_WRITE_GATE_SQL, /pg_catalog\.pg_terminate_backend/u);
  assert.match(RELEASE_WRITE_GATE_SQL, /ALTER ROLE laundry_app LOGIN/u);
  assert.doesNotMatch(INSPECT_WRITE_GATE_SQL, /ALTER ROLE/u);
});
