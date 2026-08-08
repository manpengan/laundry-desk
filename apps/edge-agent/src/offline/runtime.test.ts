import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
import { MemoryAuthorityTrustStore } from "../pairing/authority-trust.js";
import { FileQueueStore } from "../queue/file-store.js";
import { PersistentEncryptedQueue } from "../queue/persistent-queue.js";
import { SafeStorageKekStore, type SafeStorageSurface } from "../queue/safe-storage-kek.js";
import { OfflineConflictStore } from "./conflict-store.js";
import { FileGrantSequenceStore } from "./grant-sequence-store.js";
import { OfflineCommandRuntime } from "./runtime.js";

const ORG_ID = "01a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const STORE_ID = "11a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const STAFF_ID = "21a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const DEVICE_ID = "31a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const GRANT_ID = "41a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const LEASE_ID = "51a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const QUEUE_ID = "61a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const IDEMPOTENCY_ID = "71a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const AUTHORITY_NONCE = "91a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const STALE_AUTHORITY_NONCE = "a1a2eed0-a6c3-493c-a3a7-20bf94b1d678";
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

function authorityData(options: Readonly<{ requestNonce?: string; primaryLease?: boolean }> = {}) {
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
      request_nonce: options.requestNonce ?? AUTHORITY_NONCE,
      permission_version: 1,
      allowed_commands: [
        "order.receive",
        "order.hold",
        "customer.upsert",
        "print.ticket.enqueue",
        "print.ticket.retry",
        "print.ticket.reprint",
      ],
      issued_at: issuedAt,
      ttl_ms: 300_000,
      not_after: "2026-07-30T01:07:03.000Z",
    }),
    primary_lease:
      options.primaryLease === false
        ? null
        : signedLease({
            lease_id: LEASE_ID,
            grant_id: GRANT_ID,
            org_id: ORG_ID,
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

function receiveInput(method?: "cash" | "wechat" | "alipay" | "other") {
  return Object.freeze({
    name: "order.receive",
    body: Object.freeze({
      lines: Object.freeze([
        Object.freeze({ service_code: "wash", category_code: "shirt", qty: 1 }),
      ]),
      ...(method === undefined
        ? {}
        : { initial_payment: Object.freeze({ amount_cents: 100, method }) }),
    }),
  });
}

const grantCommandInputs = Object.freeze([
  receiveInput(),
  Object.freeze({
    name: "order.hold",
    body: Object.freeze({
      lines: Object.freeze([
        Object.freeze({ service_code: "wash", category_code: "shirt", qty: 1 }),
      ]),
    }),
  }),
  Object.freeze({
    name: "customer.upsert",
    body: Object.freeze({ phone: "13800000000", name: "Offline Customer" }),
  }),
  Object.freeze({
    name: "print.ticket.enqueue",
    body: Object.freeze({ order_id: QUEUE_ID }),
  }),
  Object.freeze({
    name: "print.ticket.retry",
    body: Object.freeze({ job_id: QUEUE_ID }),
  }),
  Object.freeze({
    name: "print.ticket.reprint",
    body: Object.freeze({ job_id: QUEUE_ID }),
  }),
]);

function perGrantSequence(envelope: EdgeQueueEnvelope): number | null {
  const authorization = envelope.authorization;
  return authorization.kind === "grant" && "per_grant_seq" in authorization
    ? authorization.per_grant_seq
    : null;
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
    grantSequences: new FileGrantSequenceStore(root),
    transport: {
      edge: {
        authority: async (requestNonce) => ({
          ok: true,
          data: authorityData({ requestNonce }),
        }),
        replay,
      },
    },
    authorityTrust: new MemoryAuthorityTrustStore(),
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
    assert.equal(runtime.provision(authorityData(), session, AUTHORITY_NONCE), true);
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
    assert.equal(runtime.provision(authorityData(), session, AUTHORITY_NONCE), true);
    await runtime.queueCommand(pickupInput());
    await runtime.replay();
    const status = runtime.status();
    assert.equal(status.ok, true);
    if (!status.ok) return;
    assert.equal(status.data.conflicts[0]?.error_code, "INVARIANT_FAILED");
    assert.equal(queue.status().inflightCount, 1);
    assert.match(await readFile(join(root, "offline-conflicts.json"), "utf8"), /INVARIANT_FAILED/u);

    runtime.resolve({
      queue_id: QUEUE_ID,
      action: "discard",
      reason: "operator reconciled the order",
      confirm: "DISCARD",
    });
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
      grantSequences: new FileGrantSequenceStore(root),
      transport: {
        edge: {
          authority: async (requestNonce) => {
            monotonicMs += 31_000;
            return { ok: true, data: authorityData({ requestNonce }) };
          },
          replay: async () =>
            DesktopCommandExecuteResultSchema.parse({
              ok: false,
              error: createCommandError("RESOURCE_UNAVAILABLE"),
            }),
        },
      },
      authorityTrust: new MemoryAuthorityTrustStore(),
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

test("an admin acquires an ordinary grant before best-effort Primary authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-offline-runtime-"));
  const authorityRequests: boolean[] = [];
  try {
    const queue = new PersistentEncryptedQueue({
      kekStore: new SafeStorageKekStore(root, safeStorage),
      store: new FileQueueStore(root),
    });
    const adminSession = DesktopSessionViewSchema.parse({ ...session, role: "admin" });
    const runtime = new OfflineCommandRuntime({
      queue,
      conflicts: new OfflineConflictStore(root),
      grantSequences: new FileGrantSequenceStore(root),
      transport: {
        edge: {
          authority: async (requestNonce, requestPrimary) => {
            authorityRequests.push(requestPrimary);
            if (requestPrimary) {
              return {
                ok: false,
                error: createCommandError("RESOURCE_UNAVAILABLE"),
              };
            }
            return {
              ok: true,
              data: authorityData({ requestNonce, primaryLease: false }),
            };
          },
          replay: async () =>
            DesktopCommandExecuteResultSchema.parse({
              ok: false,
              error: createCommandError("RESOURCE_UNAVAILABLE"),
            }),
        },
      },
      authorityTrust: new MemoryAuthorityTrustStore(),
      clock: Object.freeze({
        nowMs: () => 100,
        continuity: () => "trusted" as const,
      }),
    });

    assert.equal(await runtime.refreshAuthority(adminSession), true);
    assert.equal(await runtime.refreshAuthority(adminSession), false);
    assert.deepEqual(authorityRequests, [false, true]);

    const queuedCustomer = await runtime.queueCommand({
      name: "customer.upsert",
      body: { phone: "13800000000", name: "Offline Customer" },
    });
    assert.equal(queuedCustomer.ok, true);
    assert.equal(queue.status().pendingCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("authority refresh never reuses an active lease across a session authority change", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-offline-runtime-"));
  let authorityCalls = 0;
  try {
    const queue = new PersistentEncryptedQueue({
      kekStore: new SafeStorageKekStore(root, safeStorage),
      store: new FileQueueStore(root),
    });
    const runtime = new OfflineCommandRuntime({
      queue,
      conflicts: new OfflineConflictStore(root),
      grantSequences: new FileGrantSequenceStore(root),
      transport: {
        edge: {
          authority: async (requestNonce, requestPrimary) => {
            authorityCalls += 1;
            assert.equal(requestPrimary, false);
            return { ok: true, data: authorityData({ requestNonce }) };
          },
          replay: async () =>
            DesktopCommandExecuteResultSchema.parse({
              ok: false,
              error: createCommandError("RESOURCE_UNAVAILABLE"),
            }),
        },
      },
      authorityTrust: new MemoryAuthorityTrustStore(),
      clock: Object.freeze({ nowMs: () => 100, continuity: () => "trusted" as const }),
    });
    assert.equal(runtime.provision(authorityData(), session, AUTHORITY_NONCE), true);
    assert.equal(await runtime.refreshAuthority(session), true);
    assert.equal(authorityCalls, 0);

    const switchedSession = DesktopSessionViewSchema.parse({
      ...session,
      session: {
        ...session.session,
        session_version: session.session.session_version + 1,
        permission_version: session.session.permission_version + 1,
      },
    });
    assert.equal(await runtime.refreshAuthority(switchedSession), false);
    assert.equal(authorityCalls, 1);
    assert.equal(runtime.exportReadAuthority(session), null);
    assert.equal((await runtime.queueCommand(pickupInput())).ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grant-only authority enables exactly the six contract grant commands but not Primary writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-offline-runtime-"));
  let requestedPrimary: boolean | null = null;
  try {
    const queue = new PersistentEncryptedQueue({
      kekStore: new SafeStorageKekStore(root, safeStorage),
      store: new FileQueueStore(root),
    });
    const adminSession = DesktopSessionViewSchema.parse({ ...session, role: "admin" });
    const runtime = new OfflineCommandRuntime({
      queue,
      conflicts: new OfflineConflictStore(root),
      grantSequences: new FileGrantSequenceStore(root),
      transport: {
        edge: {
          authority: async (requestNonce, requestPrimary) => {
            requestedPrimary = requestPrimary;
            return {
              ok: true,
              data: authorityData({ requestNonce, primaryLease: false }),
            };
          },
          replay: async () =>
            DesktopCommandExecuteResultSchema.parse({
              ok: false,
              error: createCommandError("RESOURCE_UNAVAILABLE"),
            }),
        },
      },
      authorityTrust: new MemoryAuthorityTrustStore(),
      clock: Object.freeze({ nowMs: () => 100, continuity: () => "trusted" as const }),
    });

    assert.equal(await runtime.refreshAuthority(adminSession), true);
    assert.equal(requestedPrimary, false);
    assert.equal(
      runtime.exportReadAuthority(adminSession)?.offlineGrant.payload.grant_id,
      GRANT_ID,
    );
    const queuedResults = await Promise.all(
      grantCommandInputs.map(async (input) => runtime.queueCommand(input)),
    );
    assert.equal(
      queuedResults.every((result) => result.ok),
      true,
    );
    assert.equal((await runtime.queueCommand(pickupInput())).ok, false);
    assert.equal(
      (
        await runtime.queueCommand({
          name: "payment.refund",
          body: {
            order_id: QUEUE_ID,
            ref_payment_id: IDEMPOTENCY_ID,
            amount_cents: 100,
            method: "cash",
            reason: "denied offline",
          },
        })
      ).ok,
      false,
    );

    const queued: EdgeQueueEnvelope[] = [];
    while (true) {
      const item = queue.dequeue();
      if (item === null) break;
      queued.push(item.envelope);
      queue.ack(item.id);
    }
    assert.deepEqual(
      queued.map((envelope) => envelope.payload.command),
      grantCommandInputs.map((input) => input.name),
    );
    assert.deepEqual(
      queued.map((envelope) =>
        perGrantSequence(envelope) === null
          ? null
          : [envelope.queue_envelope_version, perGrantSequence(envelope)],
      ),
      [
        [3, 1],
        [3, 2],
        [3, 3],
        [3, 4],
        [3, 5],
        [3, 6],
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("grant order.receive permits debt or cash and rejects every non-cash payment method", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-offline-runtime-"));
  try {
    const replayed: EdgeQueueEnvelope[] = [];
    const { runtime } = createRuntime(root, async (envelope) => {
      replayed.push(envelope);
      return DesktopCommandExecuteResultSchema.parse({
        ok: true,
        data: { execution: "executed", result: {} },
      });
    });
    assert.equal(
      runtime.provision(authorityData({ primaryLease: false }), session, AUTHORITY_NONCE),
      true,
    );

    for (const method of ["wechat", "alipay", "other"] as const) {
      assert.equal((await runtime.queueCommand(receiveInput(method))).ok, false);
    }
    assert.equal((await runtime.queueCommand(receiveInput())).ok, true);
    assert.equal((await runtime.queueCommand(receiveInput("cash"))).ok, true);
    await runtime.replay();
    assert.deepEqual(replayed.map(perGrantSequence), [1, 2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persists committed grant sequence high-water across runtime restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-offline-runtime-"));
  try {
    const first = createRuntime(root, async () =>
      DesktopCommandExecuteResultSchema.parse({
        ok: false,
        error: createCommandError("RESOURCE_UNAVAILABLE"),
      }),
    );
    assert.equal(
      first.runtime.provision(authorityData({ primaryLease: false }), session, AUTHORITY_NONCE),
      true,
    );
    assert.equal((await first.runtime.queueCommand(receiveInput())).ok, true);

    const restartedQueue = new PersistentEncryptedQueue({
      kekStore: new SafeStorageKekStore(root, safeStorage),
      store: new FileQueueStore(root),
    });
    const restarted = new OfflineCommandRuntime({
      queue: restartedQueue,
      conflicts: new OfflineConflictStore(root),
      grantSequences: new FileGrantSequenceStore(root),
      transport: {
        edge: {
          authority: async (requestNonce) => ({
            ok: true,
            data: authorityData({ requestNonce, primaryLease: false }),
          }),
          replay: async () =>
            DesktopCommandExecuteResultSchema.parse({
              ok: false,
              error: createCommandError("RESOURCE_UNAVAILABLE"),
            }),
        },
      },
      authorityTrust: new MemoryAuthorityTrustStore(),
      clock: Object.freeze({ nowMs: () => 100, continuity: () => "trusted" as const }),
      randomId: () => crypto.randomUUID(),
    });
    assert.equal(
      restarted.provision(authorityData({ primaryLease: false }), session, AUTHORITY_NONCE),
      true,
    );
    assert.equal((await restarted.queueCommand(grantCommandInputs[1])).ok, true);

    const sequences: number[] = [];
    while (true) {
      const item = restartedQueue.dequeue();
      if (item === null) break;
      const sequence = perGrantSequence(item.envelope);
      if (sequence !== null) sequences.push(sequence);
      restartedQueue.ack(item.id);
    }
    assert.deepEqual(sequences, [1, 2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("provision rejects a signed authority response bound to another request nonce", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-offline-runtime-"));
  try {
    const { runtime } = createRuntime(root, async () =>
      DesktopCommandExecuteResultSchema.parse({
        ok: false,
        error: createCommandError("RESOURCE_UNAVAILABLE"),
      }),
    );
    assert.equal(
      runtime.provision(
        authorityData({ requestNonce: STALE_AUTHORITY_NONCE }),
        session,
        AUTHORITY_NONCE,
      ),
      false,
    );
    assert.equal(runtime.exportReadAuthority(session), null);
    assert.equal((await runtime.queueCommand(pickupInput())).ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("blocking lease issuance clears every authority and makes replay a zero-I/O no-op", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-offline-runtime-"));
  let dequeueCalls = 0;
  let enqueueCalls = 0;
  let replayCalls = 0;
  try {
    const runtime = new OfflineCommandRuntime({
      queue: {
        dequeue: () => {
          dequeueCalls += 1;
          return null;
        },
        enqueue: () => {
          enqueueCalls += 1;
        },
      } as unknown as PersistentEncryptedQueue,
      conflicts: new OfflineConflictStore(root),
      grantSequences: new FileGrantSequenceStore(root),
      transport: {
        edge: {
          authority: async (requestNonce) => ({
            ok: true,
            data: authorityData({ requestNonce }),
          }),
          replay: async () => {
            replayCalls += 1;
            return DesktopCommandExecuteResultSchema.parse({
              ok: true,
              data: { execution: "executed", result: {} },
            });
          },
        },
      },
      authorityTrust: new MemoryAuthorityTrustStore(),
      clock: Object.freeze({ nowMs: () => 100, continuity: () => "trusted" as const }),
      randomId: () => QUEUE_ID,
    });

    assert.equal(runtime.provision(authorityData(), session, AUTHORITY_NONCE), true);
    assert.notEqual(runtime.exportReadAuthority(session), null);
    runtime.setLeaseIssuanceBlocked(true);
    assert.equal(runtime.exportReadAuthority(session), null);
    assert.equal(runtime.provision(authorityData(), session, AUTHORITY_NONCE), false);

    await runtime.replay();
    assert.equal((await runtime.queueCommand(pickupInput())).ok, false);
    assert.deepEqual(
      { dequeueCalls, enqueueCalls, replayCalls },
      {
        dequeueCalls: 0,
        enqueueCalls: 0,
        replayCalls: 0,
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the Electron entrypoint boots recovery without confirmation or update staging", async () => {
  const compiledTestDir = dirname(fileURLToPath(import.meta.url));
  const source = await readFile(resolve(compiledTestDir, "../../src/main.ts"), "utf8");
  const runtimeConstruction = source.indexOf("offlineRuntime = new OfflineCommandRuntime");
  const leaseBlock = source.indexOf(
    'if (mode === "recovery") offlineRuntime.setLeaseIssuanceBlocked',
  );
  const serviceConstruction = source.indexOf("const desktopService = createOfflineDesktopService");
  const updateStage = source.indexOf("void controller.checkAndStage()");

  assert.match(source, /async function boot\(mode: BootMode\): Promise<void>/u);
  assert.ok(runtimeConstruction >= 0);
  assert.ok(leaseBlock > runtimeConstruction);
  assert.ok(serviceConstruction > leaseBlock);
  assert.match(source, /\{ recoveryReadOnly: mode === "recovery" \}/u);
  assert.match(source, /if \(startup\.action === "recovery"\) \{\s*bootMode = "recovery";/u);
  assert.match(
    source,
    /if \(bootMode === "normal" && updateState !== null && pendingConfirmation !== null\)/u,
  );
  assert.ok(updateStage > 0);
  assert.ok(
    source.lastIndexOf('bootMode === "normal"', updateStage) > source.indexOf("await boot"),
  );
});

test("exports only the verified signed grant for its exact session and retains it across write continuity loss", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-offline-runtime-"));
  try {
    const { runtime } = createRuntime(root, async () =>
      DesktopCommandExecuteResultSchema.parse({
        ok: false,
        error: createCommandError("RESOURCE_UNAVAILABLE"),
      }),
    );
    assert.equal(runtime.provision(authorityData(), session, AUTHORITY_NONCE), true);
    const exported = runtime.exportReadAuthority(session);
    assert.equal(exported?.offlineGrant.payload.grant_id, GRANT_ID);
    assert.equal("primaryLease" in (exported ?? {}), false);

    const rotatedSession = DesktopSessionViewSchema.parse({
      ...session,
      session: { ...session.session, session_version: 2 },
    });
    runtime.reconcileSession(rotatedSession);
    assert.equal(
      runtime.exportReadAuthority(rotatedSession)?.offlineGrant.payload.grant_id,
      GRANT_ID,
    );
    runtime.invalidateContinuity();
    assert.equal(
      runtime.exportReadAuthority(rotatedSession)?.offlineGrant.payload.grant_id,
      GRANT_ID,
    );
    const otherSession = DesktopSessionViewSchema.parse({
      ...rotatedSession,
      session: { ...rotatedSession.session, permission_version: 2 },
    });
    runtime.reconcileSession(otherSession);
    assert.equal(runtime.exportReadAuthority(otherSession), null);
    runtime.clearReadAuthority();
    assert.equal(runtime.exportReadAuthority(rotatedSession), null);
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
      grantSequences: new FileGrantSequenceStore(root),
      transport: {
        edge: {
          authority: async (requestNonce) => ({
            ok: true,
            data: authorityData({ requestNonce }),
          }),
          replay: async () =>
            DesktopCommandExecuteResultSchema.parse({
              ok: false,
              error: createCommandError("RESOURCE_UNAVAILABLE"),
            }),
        },
      },
      authorityTrust: new MemoryAuthorityTrustStore(),
      clock: Object.freeze({ nowMs: () => 100, continuity: () => "trusted" as const }),
      randomId: () => QUEUE_ID,
    });

    assert.equal(runtime.provision(authorityData(), session, AUTHORITY_NONCE), true);
    assert.equal((await runtime.queueCommand(pickupInput())).ok, false);
    assert.equal((await runtime.queueCommand(pickupInput())).ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
