import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { emptyDataProtectionState } from "./hk-vps-data-protection-contract.mjs";
import {
  dataProtectionRecoveryConfirmation,
  parseDataProtectionRecoveryConfirmation,
  readDataProtectionRecoveryInput,
  runDataProtectionRecovery,
} from "./hk-vps-data-protection-recovery.mjs";
import { CloudReleaseError } from "./hk-vps-release-core.mjs";

const SET_ID = "manual-20260812T010203Z-1234567890abcdef";
const MANIFEST_SHA = "9".repeat(64);
const SOURCE_CODE = "1".repeat(40);
const TARGET_CODE = "2".repeat(40);
const digest = (character) => character.repeat(64);

function targetSet() {
  return Object.freeze({
    setPath: `/sets/${SET_ID}`,
    dumpPath: `/sets/${SET_ID}/database.dump`,
    manifestSha256: MANIFEST_SHA,
    manifest: Object.freeze({
      set_id: SET_ID,
      kind: "manual",
      code_sha: TARGET_CODE,
      created_at: "2026-08-12T00:00:00.000Z",
      database: Object.freeze({ file: "database.dump", bytes: 12, sha256: digest("8") }),
      migration: Object.freeze({
        head: "0051_customer_extended_profiles.sql",
        count: 51,
        ledger_sha256: digest("7"),
        catalog_sha256: digest("6"),
      }),
      photos: Object.freeze({
        directory: "photos",
        count: 0,
        bytes: 0,
        inventory_sha256: digest("5"),
        files: Object.freeze([]),
      }),
    }),
  });
}

function fixture(overrides = {}) {
  const events = [];
  let operation = null;
  let state = emptyDataProtectionState();
  const target = targetSet();
  const dependencies = {
    now: (() => {
      let second = 3;
      return () => new Date(`2026-08-12T01:02:${String(second++).padStart(2, "0")}.000Z`);
    })(),
    randomBytes: (bytes) => Buffer.alloc(bytes),
    transitionExists: async () => false,
    readOperation: async () => operation,
    inspectSets: async () => ({ root: "/sets", sets: [target] }),
    drillSet: async () => events.push("target:drill"),
    findCodeTree: async () => {
      events.push("code:find");
      return `/opt/laundry-desk.failed-${TARGET_CODE}`;
    },
    laundryIdentity: async () => ({ uid: 1001, gid: 1001 }),
    readMarker: async () => ({ git_sha: SOURCE_CODE }),
    persistOperation: async (next) => {
      operation = next;
      events.push(`operation:${next.phase}`);
    },
    clearOperation: async () => {
      operation = null;
      events.push("operation:clear");
    },
    stopDesk: async () => events.push("desk:stop"),
    startDesk: async () => events.push("desk:start"),
    inspectWriteGate: async () => events.push("gate:inspect"),
    activateWriteGate: async () => events.push("gate:activate"),
    releaseWriteGate: async () => events.push("gate:release"),
    prepareSetStaging: async () => ({ stagingPath: "/sets/.set-000.tmp" }),
    captureSet: async (input) => {
      await input.onPhase("capturing");
      events.push("pre:capture");
      await input.onPhase("verifying");
      events.push("pre:verify");
      return {
        evidence: { codeSha: SOURCE_CODE },
        verified: { manifestSha256: digest("4") },
      };
    },
    prepareCode: async () => {
      events.push("code:prepare");
      return `/opt/laundry-desk.restore-${"0".repeat(32)}`;
    },
    preparePhotos: async () => {
      events.push("photos:prepare");
      return `/var/lib/laundry/photos.restore-${"0".repeat(32)}`;
    },
    verifySet: async () => {
      events.push("target:reverify");
      return target;
    },
    restoreDatabase: async () => events.push("database:restore"),
    verifyDatabase: async () => events.push("database:verify"),
    switchPhotos: async () => {
      events.push("photos:switch");
      return `/var/lib/laundry/photos.previous-${"0".repeat(32)}`;
    },
    verifyPhotos: async () => events.push("photos:verify"),
    switchCode: async () => {
      events.push("code:switch");
      return "/opt/laundry-desk.rollback-pre-1111111-20260812T010203Z";
    },
    cleanupRecoveryPath: async (path) => events.push(`cleanup:${path.split("/").at(-1)}`),
    assertDeskHealth: async () => events.push("desk:health"),
    assertSharedInfrastructure: async () => events.push("infra:health"),
    readState: async () => state,
    persistState: async (next) => {
      state = next;
      events.push("state:write");
    },
    ...overrides,
  };
  return { dependencies, events, operation: () => operation, state: () => state, target };
}

const options = Object.freeze({
  setId: SET_ID,
  confirmation: `RECOVER-${MANIFEST_SHA.slice(0, 12)}\n`,
});

test("confirmation is exact, bounded and derived from the manifest digest", async () => {
  assert.equal(dataProtectionRecoveryConfirmation(MANIFEST_SHA), `RECOVER-${"9".repeat(12)}`);
  assert.equal(parseDataProtectionRecoveryConfirmation(options.confirmation, MANIFEST_SHA), true);
  assert.equal(
    await readDataProtectionRecoveryInput(Readable.from([options.confirmation])),
    options.confirmation,
  );
  assert.throws(
    () => parseDataProtectionRecoveryConfirmation(options.confirmation.trim(), MANIFEST_SHA),
    { code: "CLOUD_DATA_RECOVERY_CONFIRMATION_INVALID" },
  );
  await assert.rejects(() => readDataProtectionRecoveryInput(Readable.from([Buffer.alloc(129)])), {
    code: "CLOUD_DATA_RECOVERY_CONFIRMATION_INVALID",
  });
});

test("joint recovery creates a verified pre-recovery set before changing database, photos and code", async () => {
  const input = fixture();
  const result = await runDataProtectionRecovery(options, input.dependencies);
  assert.equal(result.set_id, SET_ID);
  assert.ok(result.pre_recovery_set_id.startsWith("pre_recovery-"));
  assert.deepEqual(input.events, [
    "operation:intent",
    "target:drill",
    "code:find",
    "gate:inspect",
    "desk:stop",
    "operation:service_stopped",
    "operation:gate_intent",
    "gate:activate",
    "operation:gate_active",
    "operation:capturing",
    "pre:capture",
    "operation:verifying",
    "pre:verify",
    "code:prepare",
    "photos:prepare",
    "target:reverify",
    "operation:restoring",
    "database:restore",
    "database:verify",
    "photos:switch",
    "photos:verify",
    "code:switch",
    `cleanup:photos.previous-${"0".repeat(32)}`,
    "gate:release",
    "operation:gate_released",
    "desk:start",
    "desk:health",
    "infra:health",
    "state:write",
    "operation:clear",
  ]);
  assert.equal(input.state().last_recovery?.set_id, SET_ID);
});

test("database restore failure keeps Desk stopped, NOLOGIN and recovery_required", async () => {
  const input = fixture({
    restoreDatabase: async () => {
      input.events.push("database:restore");
      throw new Error("restore failed");
    },
  });
  await assert.rejects(() => runDataProtectionRecovery(options, input.dependencies), {
    code: "CLOUD_DATA_RECOVERY_REQUIRED",
  });
  assert.equal(input.operation()?.phase, "recovery_required");
  assert.equal(input.events.includes("gate:release"), false);
  assert.equal(input.events.includes("desk:start"), false);
});

test("pre-destructive preparation failure reopens the original service", async () => {
  const input = fixture({
    preparePhotos: async () => {
      throw new Error("photo preparation failed");
    },
  });
  await assert.rejects(
    () => runDataProtectionRecovery(options, input.dependencies),
    /preparation/u,
  );
  assert.ok(input.events.includes("gate:release"));
  assert.ok(input.events.includes("desk:start"));
  assert.equal(input.operation(), null);
});

test("unremoved photo staging reopens service but retains recovery authority", async () => {
  const input = fixture({
    preparePhotos: async () => {
      throw new CloudReleaseError("CLOUD_DATA_PHOTO_STAGING_CLEANUP_FAILED");
    },
  });
  await assert.rejects(() => runDataProtectionRecovery(options, input.dependencies), {
    code: "CLOUD_DATA_PHOTO_STAGING_CLEANUP_FAILED",
  });
  assert.ok(input.events.includes("gate:release"));
  assert.ok(input.events.includes("desk:start"));
  assert.equal(input.events.includes("operation:clear"), false);
  assert.notEqual(input.operation(), null);
  assert.equal(input.state().last_failure.recover?.code, "CLOUD_DATA_PHOTO_STAGING_CLEANUP_FAILED");
});

test("failed rollback health check returns to stopped NOLOGIN recovery_required", async () => {
  const input = fixture({
    preparePhotos: async () => {
      throw new Error("photo preparation failed");
    },
    assertDeskHealth: async () => {
      input.events.push("desk:health");
      throw new Error("original service unhealthy");
    },
  });
  await assert.rejects(() => runDataProtectionRecovery(options, input.dependencies), {
    code: "CLOUD_DATA_RECOVERY_REQUIRED",
  });
  assert.equal(input.events.filter((event) => event === "desk:stop").length, 2);
  assert.equal(input.events.filter((event) => event === "gate:activate").length, 2);
  assert.equal(input.events.includes("operation:clear"), false);
  assert.equal(input.operation()?.phase, "recovery_required");
});

test("post-start verification failure stops Desk and reacquires NOLOGIN", async () => {
  const input = fixture({
    assertDeskHealth: async () => {
      input.events.push("desk:health");
      throw new Error("health failed");
    },
  });
  await assert.rejects(() => runDataProtectionRecovery(options, input.dependencies), {
    code: "CLOUD_DATA_RECOVERY_REQUIRED",
  });
  assert.equal(input.events.filter((event) => event === "desk:stop").length, 2);
  assert.equal(input.events.filter((event) => event === "gate:activate").length, 2);
  assert.equal(input.operation()?.phase, "recovery_required");
});
