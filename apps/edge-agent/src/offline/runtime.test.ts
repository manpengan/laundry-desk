import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DesktopSessionViewSchema,
  DesktopCommandExecuteResultSchema,
  EdgeAuthorityDataSchema,
  canonicalizeOfflineGrantForSigning,
  canonicalizePrimaryLeaseForSigning,
  createCommandError,
  createOfflineGrantRegistrySnapshot,
  type EdgeQueueEnvelope,
  type DesktopCommandExecuteResult,
  type OfflineGrantPayload,
  type PrimaryLeasePayload,
} from "@laundry/contracts";

import { bytesToBase64Url } from "../pairing/device-keys.js";
import { FileQueueStore } from "../queue/file-store.js";
import { PersistentEncryptedQueue } from "../queue/persistent-queue.js";
import { SafeStorageKekStore, type SafeStorageSurface } from "../queue/safe-storage-kek.js";
import { OfflineConflictStore } from "./conflict-store.js";
import { OfflineCommandRuntime } from "./runtime.js";

const ORG_ID = "01a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const STORE_ID = "11a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const STAFF_ID = "21a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const DEVICE_ID = "31a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const GRANT_ID = "41a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const LEASE_ID = "51a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const QUEUE_ID = "61a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const IDEMPOTENCY_ID = "71a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const registry = createOfflineGrantRegistrySnapshot();
const keys = generateKeyPairSync("ed25519");

const safeStorage: SafeStorageSurface = Object.freeze({
  isEncryptionAvailable: () => true,
  encryptString: (plaintext) => Buffer.from(`keychain:${plaintext}`, "utf8"),
  decryptString: (ciphertext) => ciphertext.toString("utf8").slice("keychain:".length),
});

const session = DesktopSessionViewSchema.parse({
  session: {
    session_id: "81a2eed0-a6c3-493c-a3a7-20bf94b1d678",
    session_version: 1,
    org_id: ORG_ID,
    store_id: STORE_ID,
    staff_id: STAFF_ID,
    device_id: DEVICE_ID,
    permission_version: 1,
  },
  role: "staff",
  features: { pin_quick_switch: true },
  display: {
    store_name: "Test Store",
    staff_name: "Staff",
    org_code: "test",
    store_code: "one",
  },
});

function signedGrant(payload: OfflineGrantPayload) {
  const unsigned = { protocol_version: "1.0.0", payload };
  return Object.freeze({
    ...unsigned,
    sig: bytesToBase64Url(
      new Uint8Array(
        sign(null, canonicalizeOfflineGrantForSigning(unsigned, registry), keys.privateKey),
      ),
    ),
  });
}

function signedLease(payload: PrimaryLeasePayload) {
  const unsigned = { protocol_version: "1.0.0", payload };
  return Object.freeze({
    ...unsigned,
    sig: bytesToBase64Url(
      new Uint8Array(sign(null, canonicalizePrimaryLeaseForSigning(unsigned), keys.privateKey)),
    ),
  });
}

function authorityData() {
  const issuedAt = "2026-07-30T01:02:03.000Z";
  return EdgeAuthorityDataSchema.parse({
    server_public_key_spki: keys.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64"),
    offline_grant: signedGrant({
      grant_id: GRANT_ID,
      org_id: ORG_ID,
      store_id: STORE_ID,
      staff_id: STAFF_ID,
      device_id: DEVICE_ID,
      permission_version: 1,
      allowed_commands: ["order.pickup", "payment.collect", "payment.repay"],
      issued_at: issuedAt,
      ttl_ms: 300_000,
      not_after: "2026-07-30T01:07:03.000Z",
    }),
    primary_lease: signedLease({
      lease_id: LEASE_ID,
      store_id: STORE_ID,
      device_id: DEVICE_ID,
      primary_epoch: 3,
      issued_at: issuedAt,
      ttl_ms: 60_000,
      max_clock_skew_ms: 2_000,
      not_after: "2026-07-30T01:03:03.000Z",
    }),
  });
}

function pickupInput() {
  return Object.freeze({
    name: "order.pickup",
    body: Object.freeze({
      order_id: "91a2eed0-a6c3-493c-a3a7-20bf94b1d678",
      garment_ids: [],
      collect_cents: 0,
    }),
  });
}

function createRuntime(
  root: string,
  replay: (envelope: EdgeQueueEnvelope) => Promise<DesktopCommandExecuteResult>,
) {
  const queue = new PersistentEncryptedQueue({
    kekStore: new SafeStorageKekStore(root, safeStorage),
    store: new FileQueueStore(root),
  });
  const ids = [QUEUE_ID, IDEMPOTENCY_ID];
  const runtime = new OfflineCommandRuntime({
    queue,
    conflicts: new OfflineConflictStore(root),
    transport: {
      edge: {
        authority: async () => ({ ok: true, data: authorityData() }),
        replay,
      },
    },
    clock: Object.freeze({ nowMs: () => 100, continuity: () => "trusted" as const }),
    now: () => new Date("2026-07-30T01:02:04.000Z"),
    randomId: () => ids.shift() ?? crypto.randomUUID(),
  });
  return { queue, runtime };
}

test("queues pickup under signed Primary Lease and replays its original idempotency key", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-offline-runtime-"));
  try {
    const replayed: EdgeQueueEnvelope[] = [];
    const { queue, runtime } = createRuntime(root, async (envelope) => {
      replayed.push(envelope);
      return DesktopCommandExecuteResultSchema.parse({
        ok: true,
        data: { execution: "executed", result: { order_id: "ok" } },
      });
    });
    assert.equal(runtime.provision(authorityData(), session), true);
    const queued = await runtime.queueCommand(pickupInput());
    assert.equal(queued.ok, true);
    assert.equal(queue.status().pendingCount, 1);
    const text = await readFile(join(root, "offline-queue.json"), "utf8");
    assert.doesNotMatch(text, /order\.pickup|91a2eed0|71a2eed0/u);

    await runtime.replay();
    assert.equal(replayed[0]?.payload.idempotency_key, IDEMPOTENCY_ID);
    assert.equal(queue.status().pendingCount, 0);
    assert.equal(queue.status().inflightCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists business conflicts and requires explicit retry or discard", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-offline-runtime-"));
  try {
    const { queue, runtime } = createRuntime(root, async () =>
      DesktopCommandExecuteResultSchema.parse({
        ok: false,
        error: createCommandError("INVARIANT_FAILED"),
      }),
    );
    assert.equal(runtime.provision(authorityData(), session), true);
    await runtime.queueCommand(pickupInput());
    await runtime.replay();
    const status = runtime.status();
    assert.equal(status.ok, true);
    if (!status.ok) return;
    assert.equal(status.data.conflicts[0]?.error_code, "INVARIANT_FAILED");
    assert.equal(queue.status().inflightCount, 1);
    assert.match(await readFile(join(root, "offline-conflicts.json"), "utf8"), /INVARIANT_FAILED/u);

    runtime.resolve({ queue_id: QUEUE_ID, action: "discard" });
    assert.equal(queue.status().inflightCount, 0);
    const resolved = runtime.status();
    assert.equal(resolved.ok ? resolved.data.conflicts.length : -1, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("authority refresh subtracts the measured round trip from the lease lifetime", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-offline-runtime-"));
  let monotonicMs = 100;
  try {
    const queue = new PersistentEncryptedQueue({
      kekStore: new SafeStorageKekStore(root, safeStorage),
      store: new FileQueueStore(root),
    });
    const runtime = new OfflineCommandRuntime({
      queue,
      conflicts: new OfflineConflictStore(root),
      transport: {
        edge: {
          authority: async () => {
            monotonicMs += 31_000;
            return { ok: true, data: authorityData() };
          },
          replay: async () =>
            DesktopCommandExecuteResultSchema.parse({
              ok: false,
              error: createCommandError("RESOURCE_UNAVAILABLE"),
            }),
        },
      },
      clock: Object.freeze({
        nowMs: () => monotonicMs,
        continuity: () => "trusted" as const,
      }),
    });

    assert.equal(await runtime.refreshAuthority(session), false);
    assert.equal((await runtime.queueCommand(pickupInput())).ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("queue persistence failure is sanitized and invalidates the consumed lease sequence", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-offline-runtime-"));
  try {
    const runtime = new OfflineCommandRuntime({
      queue: {
        enqueue: () => {
          throw new Error("disk unavailable");
        },
      } as unknown as PersistentEncryptedQueue,
      conflicts: new OfflineConflictStore(root),
      transport: {
        edge: {
          authority: async () => ({ ok: true, data: authorityData() }),
          replay: async () =>
            DesktopCommandExecuteResultSchema.parse({
              ok: false,
              error: createCommandError("RESOURCE_UNAVAILABLE"),
            }),
        },
      },
      clock: Object.freeze({ nowMs: () => 100, continuity: () => "trusted" as const }),
      randomId: () => QUEUE_ID,
    });

    assert.equal(runtime.provision(authorityData(), session), true);
    assert.equal((await runtime.queueCommand(pickupInput())).ok, false);
    assert.equal((await runtime.queueCommand(pickupInput())).ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
