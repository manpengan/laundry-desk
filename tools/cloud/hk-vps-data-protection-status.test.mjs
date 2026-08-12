import assert from "node:assert/strict";
import test from "node:test";

import {
  createDataProtectionStatusReport,
  dataProtectionAgeSeconds,
  formatDataProtectionPrometheus,
  runDataProtectionStatus,
} from "./hk-vps-data-protection-status.mjs";

const NOW = new Date("2026-08-12T12:00:00.000Z");
const SHA = "a".repeat(64);
const CODE = "b".repeat(40);
const SET_ID = "manual-20260812T110000Z-1234567890abcdef";

function state(overrides = {}) {
  const reference = Object.freeze({
    set_id: SET_ID,
    completed_at: "2026-08-12T11:00:00.000Z",
    manifest_sha256: SHA,
  });
  return Object.freeze({
    last_backup: Object.freeze({ ...reference, code_sha: CODE }),
    last_offsite: Object.freeze({
      ...reference,
      target_id: "nas-a",
      failure_domain: "nas-taipei-a",
      remote_identity: "ed25519:SHA256:0123456789abcdef",
    }),
    last_drill: reference,
    last_recovery: null,
    last_failure: Object.freeze({ backup: null, drill: null, offsite: null, recover: null }),
    ...overrides,
  });
}

function retained() {
  return Object.freeze({
    root: "/source",
    sets: Object.freeze([
      Object.freeze({
        manifestSha256: SHA,
        manifest: Object.freeze({
          set_id: SET_ID,
          code_sha: CODE,
          migration: Object.freeze({
            head: "0051_customer_extended_profiles.sql",
            count: 51,
            ledger_sha256: "c".repeat(64),
            catalog_sha256: "d".repeat(64),
          }),
        }),
      }),
    ]),
  });
}

function dependencies(overrides = {}) {
  return {
    now: () => NOW,
    readState: async () => state(),
    inspectSets: async () => retained(),
    readOperation: async () => null,
    transitionExists: async () => false,
    assertOffsite: async () => ({
      deploymentProof: true,
      failureDomain: "nas-taipei-a",
      identity: { uid: 0, gid: 0 },
      remoteIdentity: "ed25519:SHA256:0123456789abcdef",
      setsRoot: "/target/sets",
      targetId: "nas-a",
    }),
    verifySet: async () => ({ manifestSha256: SHA }),
    inspectWriteGate: async () => undefined,
    assertDeskHealth: async () => undefined,
    assertSharedInfrastructure: async () => undefined,
    readLiveEvidence: async () => ({
      codeSha: CODE,
      migration: retained().sets[0].manifest.migration,
    }),
    writeJson: async () => undefined,
    ...overrides,
  };
}

test("status revalidates current local, offsite, drill and runtime authority", async () => {
  const report = await runDataProtectionStatus({}, dependencies());
  assert.equal(report.healthy, true);
  assert.equal(report.delivery_state, "externally_verified");
  assert.deepEqual(report.blockers, []);
  assert.deepEqual(report.ages_seconds, { backup: 3600, offsite: 3600, drill: 3600 });
  assert.match(formatDataProtectionPrometheus(report), /laundry_data_protection_healthy 1\n/u);
});

test("an uncommissioned network filesystem remains software-only and unhealthy", async () => {
  const report = await runDataProtectionStatus(
    {},
    dependencies({
      assertOffsite: async () => ({
        deploymentProof: false,
        failureDomain: "nas-taipei-a",
        identity: { uid: 0, gid: 0 },
        remoteIdentity: "ed25519:SHA256:0123456789abcdef",
        setsRoot: "/target/sets",
        targetId: "nas-a",
      }),
    }),
  );
  assert.equal(report.healthy, false);
  assert.equal(report.delivery_state, "software_only");
  assert.deepEqual(report.blockers, ["blocked_external_offsite"]);
});

test("a successful offsite copy cannot erase a newer backup failure", async () => {
  const failed = state({
    last_failure: {
      ...state().last_failure,
      backup: {
        code: "CLOUD_DATA_BACKUP_FAILED",
        failed_at: "2026-08-12T11:30:00.000Z",
      },
    },
  });
  const report = await runDataProtectionStatus({}, dependencies({ readState: async () => failed }));
  assert.equal(report.checks.offsite_verified, true);
  assert.equal(report.checks.last_failure_clear, false);
  assert.equal(report.healthy, false);
});

test("status is unhealthy for stale evidence, active work or incompatible live code", async () => {
  const stale = state({
    last_backup: {
      ...state().last_backup,
      completed_at: "2026-08-10T00:00:00.000Z",
    },
    last_failure: {
      ...state().last_failure,
      backup: {
        code: "CLOUD_DATA_DATABASE_INVALID",
        failed_at: "2026-08-12T11:30:00.000Z",
      },
    },
  });
  const report = await runDataProtectionStatus(
    {},
    dependencies({
      readState: async () => stale,
      readOperation: async () => ({ phase: "intent" }),
      readLiveEvidence: async () => ({
        codeSha: "e".repeat(40),
        migration: retained().sets[0].manifest.migration,
      }),
    }),
  );
  assert.equal(report.healthy, false);
  assert.equal(report.checks.operation_clear, false);
  assert.equal(report.checks.last_failure_clear, false);
  assert.equal(report.checks.backup_fresh, false);
  assert.equal(report.checks.source_compatible, false);
});

test("status contract rejects future clocks and malformed reports", () => {
  assert.throws(() => dataProtectionAgeSeconds("2026-08-12T12:00:01.000Z", NOW), {
    code: "CLOUD_DATA_STATUS_CLOCK_INVALID",
  });
  assert.throws(
    () =>
      createDataProtectionStatusReport({
        generated_at: NOW.toISOString(),
        checks: {},
        ages_seconds: { backup: null, offsite: null, drill: null },
        latest: { backup: null, offsite: null, drill: null },
      }),
    { code: "CLOUD_DATA_STATUS_INVALID" },
  );
});
