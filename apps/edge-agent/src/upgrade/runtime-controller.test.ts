import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { signReleaseManifest } from "./release-manifest.js";
import { RuntimeUpdateController, prepareRuntimeStartup } from "./runtime-controller.js";
import type { RuntimeUpdateIo } from "./runtime-io.js";
import {
  RUNTIME_RECOVERY_CAPABILITIES,
  RuntimeUpdateStateStore,
  type RuntimeUpdateState,
} from "./runtime-state.js";

const OLD_APP = "/Applications/laundry-desk V2.app";
const NEW_APP = "/private/update/B/laundry-desk V2.app";
const STAGE_ID = "01a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const ACTIVATION_ID = "11a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const ARTIFACT = Buffer.from("signed-update-zip", "utf8");
const DIGEST = createHash("sha256").update(ARTIFACT).digest("hex");
const keys = generateKeyPairSync("ed25519");

function manifest() {
  return signReleaseManifest(
    {
      protocol_version: 1,
      channel: "stable",
      version: "0.2.0",
      minimum_secure_version: "0.1.0",
      minimum_upgradable_version: "0.0.1",
      contracts_major: 0,
      local_schema: 3,
      published_at: "2026-07-30T01:02:03.000Z",
      artifacts: [
        {
          kind: "zip",
          name: "laundry-desk-0.2.0-mac.zip",
          size_bytes: ARTIFACT.byteLength,
          sha256: DIGEST,
        },
      ],
      rollback: {
        target_version: "0.1.0",
        artifact_sha256: "a".repeat(64),
        max_compatible_local_schema: 3,
      },
    },
    keys.privateKey,
  );
}

function queueStatus(pendingCount = 0, inflightCount = 0) {
  return Object.freeze({
    pendingCount,
    inflightCount,
    storageVersion: 1 as const,
    hasDek: true,
    kekKeyVersion: 1,
  });
}

function fakeIo(overrides: Partial<RuntimeUpdateIo> = {}): RuntimeUpdateIo {
  return Object.freeze({
    fetchManifest: async () => manifest(),
    downloadArtifact: async (_url, _authority, _name, destination) => ({
      path: join(destination, "laundry-desk-0.2.0-mac.zip"),
      sha256: DIGEST,
    }),
    extractAndVerifyMacApp: async () => NEW_APP,
    ...overrides,
  });
}

class FailingActivationStateStore extends RuntimeUpdateStateStore {
  override activate(): RuntimeUpdateState {
    throw new Error("activation interrupted");
  }
}

test("stages a verified update into standby and raises the security floor atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-update-controller-"));
  try {
    const state = new RuntimeUpdateStateStore(root, {
      currentVersion: "0.1.0",
      currentAppPath: OLD_APP,
      minimumSecureVersion: "0.1.0",
      now: () => "2026-07-30T01:00:00.000Z",
    });
    const ids = [STAGE_ID, ACTIVATION_ID];
    const leaseBlocks: boolean[] = [];
    let releaseRoot: string | undefined;
    const controller = new RuntimeUpdateController({
      manifestUrl: "https://updates.example.test/stable/latest.json",
      publicKey: keys.publicKey,
      context: {
        channel: "stable",
        current_version: "0.1.0",
        installed_minimum_secure_version: "0.1.0",
        current_local_schema: 3,
        supported_contracts_majors: [0],
      },
      state,
      io: fakeIo({
        downloadArtifact: async (_url, _authority, _name, destination) => {
          releaseRoot = destination;
          return {
            path: join(destination, "laundry-desk-0.2.0-mac.zip"),
            sha256: DIGEST,
          };
        },
      }),
      queueStatus: queueStatus,
      stagedHealth: async () => true,
      setPrimaryLeaseBlocked: (blocked) => leaseBlocks.push(blocked),
      randomId: () => ids.shift()!,
      now: () => "2026-07-30T01:03:00.000Z",
    });
    const result = await controller.checkAndStage();
    assert.deepEqual(result, {
      status: "staged",
      version: "0.2.0",
      slot: "B",
      appPath: NEW_APP,
    });
    assert.equal(state.snapshot().active_slot, "B");
    assert.equal(state.snapshot().minimum_secure_version, "0.1.0");
    assert.equal(state.snapshot().pending_activation?.nonce, ACTIVATION_ID);
    assert.deepEqual(leaseBlocks, [true]);
    assert.notEqual(releaseRoot, undefined);
    assert.equal(existsSync(releaseRoot!), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pending or inflight offline work blocks network, filesystem, and lease I/O", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-update-controller-"));
  try {
    let fetched = false;
    let queue = queueStatus(1, 0);
    const leaseBlocks: boolean[] = [];
    const state = new RuntimeUpdateStateStore(root, {
      currentVersion: "0.1.0",
      currentAppPath: OLD_APP,
      minimumSecureVersion: "0.1.0",
    });
    const controller = new RuntimeUpdateController({
      manifestUrl: "https://updates.example.test/stable/latest.json",
      publicKey: keys.publicKey,
      context: {
        channel: "stable",
        current_version: "0.1.0",
        installed_minimum_secure_version: "0.1.0",
        current_local_schema: 3,
        supported_contracts_majors: [0],
      },
      state,
      io: fakeIo({
        fetchManifest: async () => {
          fetched = true;
          return manifest();
        },
      }),
      queueStatus: () => queue,
      stagedHealth: async () => true,
      setPrimaryLeaseBlocked: (blocked) => leaseBlocks.push(blocked),
    });
    assert.deepEqual(await controller.checkAndStage(), {
      status: "blocked",
      reason: "offline_queue_not_empty",
    });
    queue = queueStatus(0, 1);
    assert.deepEqual(await controller.checkAndStage(), {
      status: "blocked",
      reason: "offline_queue_not_empty",
    });
    assert.equal(fetched, false);
    assert.equal(existsSync(join(root, "slots")), false);
    assert.deepEqual(leaseBlocks, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("work queued while checking the manifest blocks staging after the lease gate closes", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-update-controller-"));
  try {
    let queue = queueStatus();
    let downloaded = false;
    const leaseBlocks: boolean[] = [];
    const state = new RuntimeUpdateStateStore(root, {
      currentVersion: "0.1.0",
      currentAppPath: OLD_APP,
      minimumSecureVersion: "0.1.0",
    });
    const controller = new RuntimeUpdateController({
      manifestUrl: "https://updates.example.test/stable/latest.json",
      publicKey: keys.publicKey,
      context: {
        channel: "stable",
        current_version: "0.1.0",
        installed_minimum_secure_version: "0.1.0",
        current_local_schema: 3,
        supported_contracts_majors: [0],
      },
      state,
      io: fakeIo({
        fetchManifest: async () => {
          queue = queueStatus(1, 0);
          return manifest();
        },
        downloadArtifact: async (_url, _authority, _name, destination) => {
          downloaded = true;
          return {
            path: join(destination, "laundry-desk-0.2.0-mac.zip"),
            sha256: DIGEST,
          };
        },
      }),
      queueStatus: () => queue,
      stagedHealth: async () => true,
      setPrimaryLeaseBlocked: (blocked) => leaseBlocks.push(blocked),
    });

    assert.deepEqual(await controller.checkAndStage(), {
      status: "blocked",
      reason: "offline_queue_not_empty",
    });
    assert.equal(downloaded, false);
    assert.equal(existsSync(join(root, "slots")), false);
    assert.deepEqual(leaseBlocks, [true, false]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed staging removes its release root and releases the primary lease", async (t) => {
  const cases = [
    { phase: "download", reason: "download interrupted" },
    { phase: "extract", reason: "extract interrupted" },
    { phase: "team", reason: "Update app signing team does not match" },
    { phase: "health", reason: "UPDATE_STAGED_HEALTH_FAILED" },
    { phase: "activate", reason: "activation interrupted" },
  ] as const;
  for (const failure of cases) {
    await t.test(failure.phase, async () => {
      const root = await mkdtemp(join(tmpdir(), "laundry-update-controller-"));
      try {
        let releaseRoot: string | undefined;
        const StateStore =
          failure.phase === "activate" ? FailingActivationStateStore : RuntimeUpdateStateStore;
        const state = new StateStore(root, {
          currentVersion: "0.1.0",
          currentAppPath: OLD_APP,
          minimumSecureVersion: "0.1.0",
        });
        const leaseBlocks: boolean[] = [];
        const controller = new RuntimeUpdateController({
          manifestUrl: "https://updates.example.test/stable/latest.json",
          publicKey: keys.publicKey,
          context: {
            channel: "stable",
            current_version: "0.1.0",
            installed_minimum_secure_version: "0.1.0",
            current_local_schema: 3,
            supported_contracts_majors: [0],
          },
          state,
          io: fakeIo({
            downloadArtifact: async (_url, _authority, _name, destination) => {
              releaseRoot = destination;
              if (failure.phase === "download") throw new Error(failure.reason);
              return {
                path: join(destination, "laundry-desk-0.2.0-mac.zip"),
                sha256: DIGEST,
              };
            },
            extractAndVerifyMacApp: async () => {
              if (failure.phase === "extract") throw new Error(failure.reason);
              return NEW_APP;
            },
          }),
          queueStatus,
          stagedHealth: async () => {
            if (failure.phase === "team") throw new Error(failure.reason);
            return failure.phase !== "health";
          },
          setPrimaryLeaseBlocked: (blocked) => leaseBlocks.push(blocked),
          randomId: () => STAGE_ID,
        });
        assert.deepEqual(await controller.checkAndStage(), {
          status: "failed",
          reason: failure.reason,
        });
        assert.notEqual(releaseRoot, undefined);
        assert.equal(existsSync(releaseRoot!), false);
        assert.deepEqual(leaseBlocks, [true, false]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("pending activation confirms once or rolls back after an interrupted launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-update-controller-"));
  try {
    const state = new RuntimeUpdateStateStore(root, {
      currentVersion: "0.1.0",
      currentAppPath: OLD_APP,
      minimumSecureVersion: "0.1.0",
    });
    state.activate({
      slot: "B",
      version: "0.2.0",
      appPath: NEW_APP,
      artifactSha256: DIGEST,
      nonce: ACTIVATION_ID,
      now: "2026-07-30T01:03:00.000Z",
      minimumSecureVersion: "0.1.0",
    });
    assert.deepEqual(prepareRuntimeStartup(state, OLD_APP, null), {
      action: "launch",
      appPath: NEW_APP,
      activationNonce: ACTIVATION_ID,
    });
    assert.deepEqual(prepareRuntimeStartup(state, NEW_APP, ACTIVATION_ID), {
      action: "continue",
      pendingConfirmation: { slot: "B", nonce: ACTIVATION_ID },
    });
    assert.deepEqual(prepareRuntimeStartup(state, OLD_APP, null), {
      action: "continue",
      pendingConfirmation: null,
    });
    assert.equal(state.snapshot().active_slot, "A");
    assert.equal(state.snapshot().slots.B.healthy, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("security floor enters stable idempotent recovery without changing pending activation", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-update-controller-"));
  try {
    const state = new RuntimeUpdateStateStore(root, {
      currentVersion: "0.1.0",
      currentAppPath: OLD_APP,
      minimumSecureVersion: "0.1.0",
    });
    state.activate({
      slot: "B",
      version: "0.2.0",
      appPath: NEW_APP,
      artifactSha256: DIGEST,
      nonce: ACTIVATION_ID,
      now: "2026-07-30T01:03:00.000Z",
      minimumSecureVersion: "0.2.0",
    });
    assert.equal(prepareRuntimeStartup(state, OLD_APP, null).action, "launch");
    const beforeRecovery = state.snapshot();

    const first = prepareRuntimeStartup(state, OLD_APP, null, () => "2026-07-30T01:04:00.000Z");
    assert.deepEqual(first, {
      action: "recovery",
      capabilities: ["read_only", "print_only"],
    });
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.capabilities), true);
    assert.equal(first.capabilities, RUNTIME_RECOVERY_CAPABILITIES);
    assert.equal(state.snapshot().active_slot, beforeRecovery.active_slot);
    assert.deepEqual(state.snapshot().pending_activation, beforeRecovery.pending_activation);

    const decision = state.rollbackPending("2026-07-30T01:05:00.000Z");
    assert.equal(decision.status, "recovery_required");
    assert.equal(decision.state, state.snapshot());
    assert.equal(
      state.snapshot().history.filter((entry) => entry.event === "security_floor_recovery_required")
        .length,
      1,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
