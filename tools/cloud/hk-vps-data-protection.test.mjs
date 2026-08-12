import assert from "node:assert/strict";
import test from "node:test";

import { REMOTE_RELEASE_LOCK } from "./hk-vps-release-core.mjs";
import {
  executeDataProtectionAction,
  lockedDataProtectionArguments,
  main,
  parseDataProtectionArguments,
} from "./hk-vps-data-protection.mjs";
import { createDataProtectionStatusReport } from "./hk-vps-data-protection-status.mjs";

const SET_ID = "manual-20260812T110000Z-1234567890abcdef";

test("CLI accepts only the fixed data-protection action grammar", () => {
  assert.deepEqual(parseDataProtectionArguments(["backup", "--scheduled"]), {
    action: "backup",
    format: "json",
    scheduled: true,
    setId: null,
  });
  assert.deepEqual(parseDataProtectionArguments(["drill", "--set-id", SET_ID]), {
    action: "drill",
    format: "json",
    scheduled: false,
    setId: SET_ID,
  });
  assert.equal(
    parseDataProtectionArguments(["status", "--format", "prometheus"]).format,
    "prometheus",
  );
  assert.equal(parseDataProtectionArguments(["recover", "--set-id", SET_ID]).action, "recover");
  for (const arguments_ of [
    [],
    ["recover"],
    ["recover", SET_ID],
    ["backup", "--set-id", SET_ID],
    ["status", "--format", "text"],
    ["offsite", "--set-id", "../../etc"],
  ]) {
    assert.throws(() => parseDataProtectionArguments(arguments_), {
      code: "CLOUD_DATA_ARGS_INVALID",
    });
  }
});

test("locked launcher binds every action to the release lock and fixed Node", () => {
  assert.deepEqual(
    lockedDataProtectionArguments("/opt/laundry-desk/tools/cloud/hk-vps-data-protection.mjs", {
      action: "offsite",
      format: "json",
      scheduled: false,
      setId: SET_ID,
    }),
    [
      "--no-fork",
      "--exclusive",
      "--nonblock",
      "--conflict-exit-code",
      "73",
      REMOTE_RELEASE_LOCK,
      "/opt/nodejs/bin/node",
      "/opt/laundry-desk/tools/cloud/hk-vps-data-protection.mjs",
      "--lock-held",
      "offsite",
      "--set-id",
      SET_ID,
    ],
  );
});

test("the internal lock marker is accepted only after inherited-lock verification", async () => {
  let asserted = 0;
  const output = [];
  const code = await main(["--lock-held", "status"], {
    uid: 0,
    assertLockHeld: async () => {
      asserted += 1;
    },
    processObject: { on: () => undefined, off: () => undefined },
    runStatus: async () =>
      createDataProtectionStatusReport({
        generated_at: "2026-08-12T12:00:00.000Z",
        checks: {
          operation_clear: true,
          release_clear: true,
          last_failure_clear: true,
          backup_fresh: false,
          offsite_fresh: false,
          drill_fresh: false,
          backup_verified: false,
          offsite_verified: false,
          offsite_attested: false,
          drill_set_verified: false,
          write_gate_open: true,
          service_healthy: true,
          source_compatible: false,
        },
        ages_seconds: { backup: null, offsite: null, drill: null },
        latest: { backup: null, offsite: null, drill: null },
      }),
    stdout: { write: (value) => output.push(value) },
  });
  assert.equal(asserted, 1);
  assert.equal(code, 1);
  assert.match(output.join(""), /"healthy":false/u);
});

test("action dispatcher exposes only bounded JSON or Prometheus and failure exit", async () => {
  const backup = await executeDataProtectionAction(
    parseDataProtectionArguments(["backup"]),
    undefined,
    { runBackup: async () => ({ set_id: SET_ID }) },
  );
  assert.deepEqual(JSON.parse(backup.output), {
    ok: true,
    action: "backup",
    result: { set_id: SET_ID },
  });
  const status = await executeDataProtectionAction(
    parseDataProtectionArguments(["status", "--format", "prometheus"]),
    undefined,
    {
      runStatus: async () =>
        createDataProtectionStatusReport({
          generated_at: "2026-08-12T12:00:00.000Z",
          checks: {
            operation_clear: true,
            release_clear: true,
            last_failure_clear: true,
            backup_fresh: false,
            offsite_fresh: false,
            drill_fresh: false,
            backup_verified: false,
            offsite_verified: false,
            offsite_attested: false,
            drill_set_verified: false,
            write_gate_open: true,
            service_healthy: true,
            source_compatible: false,
          },
          ages_seconds: { backup: null, offsite: null, drill: null },
          latest: { backup: null, offsite: null, drill: null },
        }),
    },
  );
  assert.equal(status.exitCode, 1);
  assert.match(status.output, /^# TYPE laundry_data_protection_healthy gauge\n/u);
});
