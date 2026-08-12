import assert from "node:assert/strict";
import test from "node:test";

import {
  runDataProtectionBackup,
  runDataProtectionDrill,
} from "./hk-vps-data-protection-backup.mjs";
import { emptyDataProtectionState } from "./hk-vps-data-protection-contract.mjs";
import { CloudReleaseError } from "./hk-vps-release-core.mjs";

const setId = "manual-20260812T010203Z-0000000000000000";
const digest = (character) => character.repeat(64);

function backupFixture(overrides = {}) {
  const events = [];
  let operation = null;
  let state = emptyDataProtectionState();
  const verification = Object.freeze({
    dumpPath: "/private/staging/database.dump",
    manifestSha256: digest("9"),
    manifest: Object.freeze({
      set_id: setId,
      migration: Object.freeze({ ledger_sha256: digest("2"), catalog_sha256: digest("3") }),
      photos: Object.freeze({ inventory_sha256: digest("4"), files: Object.freeze([]) }),
    }),
  });
  const dependencies = {
    now: (() => {
      let seconds = 3;
      return () => new Date(`2026-08-12T01:02:${String(seconds++).padStart(2, "0")}.000Z`);
    })(),
    randomBytes: (bytes) => Buffer.alloc(bytes),
    transitionExists: async () => false,
    readOperation: async () => operation,
    persistOperation: async (next) => {
      operation = next;
      events.push(`operation:${next.phase}`);
    },
    clearOperation: async () => {
      operation = null;
      events.push("operation:clear");
    },
    prepareStaging: async () => ({ stagingPath: "/private/staging" }),
    cleanupStaging: async () => events.push("staging:cleanup"),
    laundryIdentity: async () => ({ uid: 501, gid: 20 }),
    readMarker: async () => ({ git_sha: "1".repeat(40) }),
    stopDesk: async () => events.push("desk:stop"),
    startDesk: async () => events.push("desk:start"),
    inspectWriteGate: async () => events.push("gate:inspect"),
    activateWriteGate: async () => events.push("gate:activate"),
    releaseWriteGate: async () => events.push("gate:release"),
    readSourceEvidence: async () => ({
      codeSha: "1".repeat(40),
      migration: Object.freeze({
        head: "0051_customer_extended_profiles.sql",
        count: 51,
        ledger_sha256: digest("2"),
        catalog_sha256: digest("3"),
      }),
      photos: Object.freeze([]),
    }),
    createDump: async () => ({ file: "database.dump", bytes: 12, sha256: digest("5") }),
    capturePhotos: async () => ({
      directory: "photos",
      count: 0,
      bytes: 0,
      inventory_sha256: digest("4"),
      files: Object.freeze([]),
    }),
    writeJson: async (path) => events.push(`write:${path.split("/").at(-1)}`),
    verifySet: async (path, options) =>
      options?.requireVerification === false
        ? verification
        : Object.freeze({ ...verification, setPath: path }),
    drillSet: async () => ({
      migrationLedgerSha256: digest("2"),
      catalogSha256: digest("3"),
      photoInventorySha256: digest("4"),
    }),
    publishSet: async () => "/private/sets/" + setId,
    assertDeskHealth: async () => events.push("desk:health"),
    readState: async () => state,
    persistState: async (next) => {
      state = next;
      events.push("state:write");
    },
    ...overrides,
  };
  return { dependencies, events, operation: () => operation, state: () => state };
}

test("backup persists intent before stopping, verifies before publish, then reopens writes", async () => {
  const fixture = backupFixture();
  const result = await runDataProtectionBackup({ kind: "manual" }, fixture.dependencies);
  assert.equal(result.set_id, setId);
  assert.deepEqual(fixture.events, [
    "operation:intent",
    "gate:inspect",
    "desk:stop",
    "operation:service_stopped",
    "operation:gate_intent",
    "gate:activate",
    "operation:gate_active",
    "operation:capturing",
    "write:manifest.json",
    "operation:verifying",
    "write:verification.json",
    "gate:release",
    "operation:gate_released",
    "desk:start",
    "desk:health",
    "state:write",
    "operation:clear",
  ]);
  assert.equal(fixture.state().last_backup?.set_id, setId);
});

test("capture failure releases the gate, restarts Desk and records a stable failure", async () => {
  const fixture = backupFixture({
    createDump: async () => {
      throw Object.assign(new Error("dump"), { code: "CLOUD_DATA_DATABASE_INVALID" });
    },
  });
  await assert.rejects(
    () => runDataProtectionBackup({ kind: "manual" }, fixture.dependencies),
    /dump/u,
  );
  assert.ok(fixture.events.includes("gate:release"));
  assert.ok(fixture.events.includes("desk:start"));
  assert.ok(fixture.events.includes("staging:cleanup"));
  assert.ok(fixture.events.indexOf("staging:cleanup") < fixture.events.indexOf("operation:clear"));
  assert.equal(fixture.operation(), null);
  assert.equal(fixture.state().last_failure.backup?.code, "CLOUD_DATA_BACKUP_FAILED");
});

test("failed gate recovery preserves recovery_required and never starts silently", async () => {
  const fixture = backupFixture({
    createDump: async () => {
      throw new Error("dump");
    },
    releaseWriteGate: async () => {
      throw new Error("release");
    },
  });
  await assert.rejects(() => runDataProtectionBackup({ kind: "manual" }, fixture.dependencies), {
    code: "CLOUD_DATA_RECOVERY_REQUIRED",
  });
  assert.equal(fixture.operation()?.phase, "recovery_required");
});

test("post-start health failure stops Desk, restores NOLOGIN and preserves recovery state", async () => {
  const fixture = backupFixture({
    assertDeskHealth: async () => {
      fixture.events.push("desk:health-failed");
      throw new Error("health");
    },
  });
  await assert.rejects(() => runDataProtectionBackup({ kind: "manual" }, fixture.dependencies), {
    code: "CLOUD_DATA_RECOVERY_REQUIRED",
  });
  assert.equal(fixture.events.filter((event) => event === "desk:stop").length, 2);
  assert.equal(fixture.events.filter((event) => event === "gate:activate").length, 2);
  assert.equal(fixture.events.includes("operation:clear"), false);
  assert.equal(fixture.operation()?.phase, "recovery_required");
});

test("failure evidence write failure restores availability but keeps the operation visible", async () => {
  const fixture = backupFixture({
    createDump: async () => {
      throw new Error("dump");
    },
    persistState: async () => {
      throw new Error("state unavailable");
    },
  });
  await assert.rejects(
    () => runDataProtectionBackup({ kind: "manual" }, fixture.dependencies),
    /state unavailable/u,
  );
  assert.ok(fixture.events.includes("desk:start"));
  assert.equal(fixture.events.includes("operation:clear"), false);
  assert.notEqual(fixture.operation(), null);
});

test("staging cleanup failure keeps its operation identity and stable failure", async () => {
  const fixture = backupFixture({
    createDump: async () => {
      throw new Error("dump");
    },
    cleanupStaging: async () => {
      throw new CloudReleaseError("CLOUD_DATA_STAGING_CLEANUP_FAILED");
    },
  });
  await assert.rejects(() => runDataProtectionBackup({ kind: "manual" }, fixture.dependencies), {
    code: "CLOUD_DATA_STAGING_CLEANUP_FAILED",
  });
  assert.equal(fixture.events.includes("operation:clear"), false);
  assert.notEqual(fixture.operation(), null);
  assert.equal(fixture.state().last_failure.backup?.code, "CLOUD_DATA_STAGING_CLEANUP_FAILED");
});

test("invalid newly prepared staging retains the operation-derived path authority", async () => {
  const fixture = backupFixture({
    prepareStaging: async () => {
      throw new CloudReleaseError("CLOUD_DATA_STAGING_INVALID");
    },
  });
  await assert.rejects(() => runDataProtectionBackup({ kind: "manual" }, fixture.dependencies), {
    code: "CLOUD_DATA_STAGING_INVALID",
  });
  assert.equal(fixture.events.includes("operation:clear"), false);
  assert.notEqual(fixture.operation(), null);
});

test("independent drill rereads the latest retained set and updates only drill evidence", async () => {
  const fixture = backupFixture({
    inspectSets: async () => ({
      sets: [
        Object.freeze({
          manifest: Object.freeze({
            set_id: setId,
            created_at: "2026-08-12T01:02:03.000Z",
          }),
          manifestSha256: digest("9"),
        }),
      ],
    }),
  });
  const result = await runDataProtectionDrill({}, fixture.dependencies);
  assert.equal(result.set_id, setId);
  assert.equal(fixture.state().last_drill?.set_id, setId);
  assert.equal(fixture.state().last_backup, null);
});

test("a failed shadow drop keeps the drill operation and deterministic cleanup identity", async () => {
  const fixture = backupFixture({
    inspectSets: async () => ({
      sets: [
        Object.freeze({
          manifest: Object.freeze({ set_id: setId, created_at: "2026-08-12T01:02:03.000Z" }),
          manifestSha256: digest("9"),
        }),
      ],
    }),
    drillSet: async () => {
      throw new CloudReleaseError("CLOUD_DATA_SHADOW_DROP_FAILED");
    },
  });
  await assert.rejects(() => runDataProtectionDrill({}, fixture.dependencies), {
    code: "CLOUD_DATA_SHADOW_DROP_FAILED",
  });
  assert.equal(fixture.events.includes("operation:clear"), false);
  assert.notEqual(fixture.operation(), null);
  assert.equal(fixture.state().last_failure.drill?.code, "CLOUD_DATA_SHADOW_DROP_FAILED");
});
