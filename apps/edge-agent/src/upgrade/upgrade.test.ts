import assert from "node:assert/strict";
import test from "node:test";
import { healthFromPassFail } from "./health.js";
import { installStandby } from "./install.js";
import { decideRollback } from "./matrix.js";
import { rollbackSlot } from "./rollback.js";
import { canRestoreSnapshot, sha256Hex, snapshotId } from "./snapshot.js";
import { createInitialState } from "./state.js";
import type { SupportMatrix } from "./types.js";
import { compareVersion, isBelowMinSecure } from "./version.js";

const fixedNow = () => "2026-07-20T00:00:00.000Z";

const matrix: SupportMatrix = {
  rows: [
    {
      edge: "2.0.0",
      rollbackToEdge: "1.9.0",
      rollbackReadsSchema: true,
      notes: "contract not done",
    },
    {
      edge: "2.1.0",
      rollbackToEdge: "2.0.0",
      rollbackReadsSchema: false,
      notes: "schema contracted",
    },
  ],
};

test("compareVersion orders semver triples", () => {
  assert.ok(compareVersion("2.0.0", "1.9.0") > 0);
  assert.equal(compareVersion("1.8.0", "1.8.0"), 0);
  assert.ok(isBelowMinSecure("1.0.0", "1.8.0"));
  assert.equal(isBelowMinSecure("1.8.0", "1.8.0"), false);
});

test("install rejects below min secure version (anti-rollback)", () => {
  const state = createInitialState();
  const r = installStandby(state, {
    version: "1.0.0",
    health: healthFromPassFail(true),
    now: fixedNow,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "below_min_secure_version");
});

test("install rejects when offline queue not empty", () => {
  const state = createInitialState({ queueEmpty: false });
  const r = installStandby(state, {
    version: "2.0.0",
    health: healthFromPassFail(true),
    now: fixedNow,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, "queue_not_empty");
});

test("health fail keeps active slot and clears lease block", () => {
  const state = createInitialState();
  const r = installStandby(state, {
    version: "2.0.0",
    health: healthFromPassFail(false),
    now: fixedNow,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.switched, false);
    assert.equal(r.state.activeSlot, "A");
    assert.equal(r.state.slots.B.version, null);
    assert.equal(r.state.primaryLeaseIssuanceBlocked, false);
    assert.equal(r.state.mode, "ACTIVE");
  }
});

test("health pass switches active slot to standby", () => {
  const state = createInitialState();
  const r = installStandby(state, {
    version: "2.0.0",
    health: healthFromPassFail(true),
    now: fixedNow,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.switched, true);
    assert.equal(r.state.activeSlot, "B");
    assert.equal(r.state.slots.B.version, "2.0.0");
    assert.equal(r.state.primaryLeaseIssuanceBlocked, false);
  }
});

test("matrix forbids rollback after contract → recovery mode", () => {
  let state = createInitialState();
  const installed = installStandby(state, {
    version: "2.1.0",
    health: healthFromPassFail(true),
    applyContract: true,
    now: fixedNow,
  });
  assert.equal(installed.ok, true);
  if (!installed.ok) return;
  state = installed.state;
  assert.equal(state.contractPhaseDone, true);

  const r = rollbackSlot(state, { matrix, now: fixedNow });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.mode, "RECOVERY_MODE");
    assert.deepEqual(r.capabilities, ["print_only", "read_only"]);
    assert.equal(r.state.mode, "RECOVERY_MODE");
  }
});

test("matrix allows rollback when row says reads schema", () => {
  let state = createInitialState();
  const installed = installStandby(state, {
    version: "2.0.0",
    health: healthFromPassFail(true),
    now: fixedNow,
  });
  assert.equal(installed.ok, true);
  if (!installed.ok) return;
  state = installed.state;

  const r = rollbackSlot(state, {
    matrix,
    targetVersion: "1.9.0",
    now: fixedNow,
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.mode, "ACTIVE");
    assert.equal(r.state.activeSlot, "A");
    assert.equal(r.state.slots.A.version, "1.9.0");
  }
});

test("decideRollback mismatch target is denied", () => {
  const state = createInitialState({
    activeSlot: "B",
    slots: {
      A: { version: "1.9.0", healthy: true },
      B: { version: "2.0.0", healthy: true },
    },
  });
  const d = decideRollback(state, matrix, "1.0.0");
  assert.equal(d.allowed, false);
  assert.match(d.reason, /mismatch/);
});

test("snapshot helpers hash and restore gate", () => {
  assert.equal(snapshotId("A", "2026"), "2026-A.db.spike");
  const h = sha256Hex("payload");
  assert.equal(h.length, 64);
  assert.equal(canRestoreSnapshot({ snapshotExists: false }).ok, false);
  assert.equal(
    canRestoreSnapshot({
      snapshotExists: true,
      expectedHash: h,
      actualHash: h,
    }).ok,
    true,
  );
  assert.equal(
    canRestoreSnapshot({
      snapshotExists: true,
      expectedHash: h,
      actualHash: sha256Hex("other"),
    }).ok,
    false,
  );
});

test("forceMatrixAllowed false enters recovery without matrix read", () => {
  const state = createInitialState({
    activeSlot: "B",
    slots: {
      A: { version: "1.9.0", healthy: true },
      B: { version: "2.0.0", healthy: true },
    },
  });
  const r = rollbackSlot(state, {
    matrix,
    forceMatrixAllowed: false,
    now: fixedNow,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.mode, "RECOVERY_MODE");
});
