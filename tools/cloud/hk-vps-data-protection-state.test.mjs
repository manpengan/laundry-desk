import assert from "node:assert/strict";
import test from "node:test";

import {
  emptyDataProtectionState,
  parseDataProtectionState,
} from "./hk-vps-data-protection-contract.mjs";
import {
  createDataProtectionOperation,
  readDataProtectionState,
  updateDataProtectionOperation,
} from "./hk-vps-data-protection-state.mjs";

test("state starts empty and accepts only exact bounded success/failure evidence", async () => {
  assert.deepEqual(
    await readDataProtectionState({
      lstat: async () => {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      },
    }),
    emptyDataProtectionState(),
  );
  const state = parseDataProtectionState({
    ...emptyDataProtectionState(),
    last_backup: {
      set_id: "manual-20260812T010203Z-0123456789abcdef",
      completed_at: "2026-08-12T01:03:03.000Z",
      manifest_sha256: "1".repeat(64),
      code_sha: "2".repeat(40),
    },
    last_failure: {
      ...emptyDataProtectionState().last_failure,
      backup: {
        code: "CLOUD_DATA_DATABASE_INVALID",
        failed_at: "2026-08-12T01:04:03.000Z",
      },
    },
  });
  assert.equal(state.last_backup?.code_sha, "2".repeat(40));
  const recovered = parseDataProtectionState({
    ...emptyDataProtectionState(),
    last_recovery: {
      set_id: "manual-20260812T010203Z-0123456789abcdef",
      completed_at: "2026-08-12T01:03:03.000Z",
      manifest_sha256: "1".repeat(64),
      code_sha: "2".repeat(40),
      pre_recovery_set_id: "pre_recovery-20260812T010203Z-fedcba9876543210",
      rollback_code_path: "/opt/laundry-desk.rollback-pre-2222222-20260812T010203Z",
    },
  });
  assert.equal(recovered.last_recovery?.pre_recovery_set_id.startsWith("pre_recovery-"), true);
  assert.throws(() => parseDataProtectionState({ ...state, secret: true }), {
    code: "CLOUD_DATA_STATE_INVALID",
  });
});

test("operation transitions preserve identity and require persisted gate authority", () => {
  const started = createDataProtectionOperation(
    "backup",
    "manual-20260812T010203Z-0123456789abcdef",
    new Date("2026-08-12T01:02:03.000Z"),
    { randomBytes: () => Buffer.from("a".repeat(32), "hex") },
  );
  const stopped = updateDataProtectionOperation(
    started,
    { phase: "service_stopped" },
    new Date("2026-08-12T01:02:04.000Z"),
  );
  const gated = updateDataProtectionOperation(
    stopped,
    { phase: "gate_intent", app_role_original_can_login: true },
    new Date("2026-08-12T01:02:05.000Z"),
  );
  assert.equal(gated.operation_id, started.operation_id);
  assert.equal(gated.app_role_original_can_login, true);
  assert.throws(
    () =>
      updateDataProtectionOperation(
        stopped,
        { phase: "gate_active" },
        new Date("2026-08-12T01:02:05.000Z"),
      ),
    { code: "CLOUD_DATA_OPERATION_INVALID" },
  );
});
