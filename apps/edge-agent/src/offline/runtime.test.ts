import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DesktopSessionViewSchema,
  DesktopCommandExecuteResultSchema,
  createCommandError,
  type EdgeQueueEnvelope,
} from "@laundry/contracts";

import { MemoryAuthorityTrustStore } from "../pairing/authority-trust.js";
import { FileQueueStore } from "../queue/file-store.js";
import { PersistentEncryptedQueue } from "../queue/persistent-queue.js";
import { SafeStorageKekStore } from "../queue/safe-storage-kek.js";
import { OfflineConflictStore } from "./conflict-store.js";
import { FileGrantSequenceStore } from "./grant-sequence-store.js";
import { OfflineCommandRuntime } from "./runtime.js";

import {
  GRANT_ID,
  QUEUE_ID,
  IDEMPOTENCY_ID,
  AUTHORITY_NONCE,
  STALE_AUTHORITY_NONCE,
  safeStorage,
  session,
  authorityData,
  pickupInput,
  receiveInput,
  grantCommandInputs,
  perGrantSequence,
  createRuntime,
} from "./runtime-test-fixtures.js";

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

test("a command that may have reached the server replays under the key it was sent with", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-offline-runtime-"));
  const sentKey = "81a2eed0-a6c3-493c-a3a7-20bf94b1d678";
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
    // A malformed key is refused before any sequence is reserved, so queuing continues.
    const refused = await runtime.queueCommand(pickupInput(), { idempotencyKey: "not-a-key" });
    assert.equal(refused.ok, false);
    assert.equal(queue.status().pendingCount, 0);
    assert.equal((await runtime.queueCommand(pickupInput(), { idempotencyKey: sentKey })).ok, true);
    await runtime.replay();
    assert.equal(replayed[0]?.payload.idempotency_key, sentKey);
    assert.equal(queue.status().pendingCount, 0);
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

test("acks a CUSTOMER_ERASED replay terminal and deletes its encrypted queue item", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-offline-runtime-"));
  try {
    const { queue, runtime } = createRuntime(root, async () =>
      DesktopCommandExecuteResultSchema.parse({
        ok: false,
        error: createCommandError("CUSTOMER_ERASED"),
      }),
    );
    assert.equal(
      runtime.provision(authorityData({ primaryLease: false }), session, AUTHORITY_NONCE),
      true,
    );
    assert.equal((await runtime.queueCommand(grantCommandInputs[2])).ok, true);
    assert.equal(queue.status().pendingCount, 1);

    await runtime.replay();

    assert.equal(queue.status().pendingCount, 0);
    assert.equal(queue.status().inflightCount, 0);
    const status = runtime.status();
    assert.equal(status.ok ? status.data.conflicts.length : -1, 0);
    assert.doesNotMatch(await readFile(join(root, "offline-queue.json"), "utf8"), /13800000000/u);
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
