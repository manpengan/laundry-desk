import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { FileQueueStore } from "./file-store.js";
import { PersistentEncryptedQueue } from "./persistent-queue.js";
import { SafeStorageKekStore, type SafeStorageSurface } from "./safe-storage-kek.js";
import { QueueCryptoError } from "./types.js";

const QUEUE_ID = "32ff7821-0b72-4f9c-8ec6-8d7e08500e04";
const SECOND_QUEUE_ID = "42ff7821-0b72-4f9c-8ec6-8d7e08500e04";
const GRANT_ID = "f7c4b945-2f08-41f3-b8da-b1af3f7ac547";

const fakeSafeStorage: SafeStorageSurface = Object.freeze({
  isEncryptionAvailable: () => true,
  encryptString: (plaintext) => Buffer.from(`protected:${plaintext}`, "utf8"),
  decryptString: (ciphertext) => {
    const value = ciphertext.toString("utf8");
    if (!value.startsWith("protected:")) throw new Error("invalid protected value");
    return value.slice("protected:".length);
  },
});

function envelope() {
  return {
    queue_envelope_version: 3,
    contracts_major: 0,
    queue_id: QUEUE_ID,
    enqueued_at: "2026-07-30T01:02:03.000Z",
    payload: {
      command: "order.receive",
      version: "0.3.0",
      mode: "direct",
      args: { customer_phone: "13800000000" },
      idempotency_key: "9dfc4424-9b9a-4e52-baaa-c02868f8e7de",
      dry_run: false,
    },
    authorization: {
      kind: "grant" as const,
      grant_id: GRANT_ID,
      per_grant_seq: 1,
    },
  };
}

test("persistent queue survives restart with ciphertext-only storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-persistent-queue-"));
  try {
    const first = new PersistentEncryptedQueue({
      kekStore: new SafeStorageKekStore(root, fakeSafeStorage),
      store: new FileQueueStore(root),
    });
    first.enqueue(envelope(), QUEUE_ID);
    const queueText = await readFile(join(root, "offline-queue.json"), "utf8");
    assert.doesNotMatch(queueText, /order\.receive|13800000000|f7c4b945/u);
    const keyText = await readFile(join(root, "queue-key.json"), "utf8");
    assert.match(keyText, /protected_kek/u);
    assert.doesNotMatch(keyText, /"protected_kek":"[A-Za-z0-9+/]{43}="/u);

    const restarted = new PersistentEncryptedQueue({
      kekStore: new SafeStorageKekStore(root, fakeSafeStorage),
      store: new FileQueueStore(root),
    });
    assert.deepEqual(restarted.status(), {
      pendingCount: 1,
      inflightCount: 0,
      storageVersion: 1,
      hasDek: true,
      kekKeyVersion: 1,
    });
    const item = restarted.dequeue();
    assert.equal(item?.envelope.payload.command, "order.receive");
    assert.equal(restarted.status().inflightCount, 1);
    assert.equal(restarted.ack(QUEUE_ID), true);
    assert.equal(restarted.status().inflightCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("persistent queue fails closed when ciphertext is tampered", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-persistent-queue-"));
  try {
    const queue = new PersistentEncryptedQueue({
      kekStore: new SafeStorageKekStore(root, fakeSafeStorage),
      store: new FileQueueStore(root),
    });
    queue.enqueue(envelope(), QUEUE_ID);
    const path = join(root, "offline-queue.json");
    const state = JSON.parse(await readFile(path, "utf8")) as {
      rows: Array<{ sealed_payload: string }>;
    };
    const sealed = Buffer.from(state.rows[0]!.sealed_payload, "base64");
    sealed[sealed.length - 1] = sealed[sealed.length - 1]! ^ 0x55;
    state.rows[0]!.sealed_payload = sealed.toString("base64");
    await writeFile(path, `${JSON.stringify(state)}\n`, "utf8");

    const restarted = new PersistentEncryptedQueue({
      kekStore: new SafeStorageKekStore(root, fakeSafeStorage),
      store: new FileQueueStore(root),
    });
    assert.throws(() => restarted.dequeue(), QueueCryptoError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restart retries the oldest inflight item before newer pending work", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-persistent-queue-"));
  try {
    const first = new PersistentEncryptedQueue({
      kekStore: new SafeStorageKekStore(root, fakeSafeStorage),
      store: new FileQueueStore(root),
    });
    first.enqueue(envelope(), QUEUE_ID);
    first.enqueue({ ...envelope(), queue_id: SECOND_QUEUE_ID }, SECOND_QUEUE_ID);
    assert.equal(first.dequeue()?.id, QUEUE_ID);

    const restarted = new PersistentEncryptedQueue({
      kekStore: new SafeStorageKekStore(root, fakeSafeStorage),
      store: new FileQueueStore(root),
    });
    assert.equal(restarted.dequeue()?.id, QUEUE_ID);
    assert.equal(restarted.ack(QUEUE_ID), true);
    assert.equal(restarted.dequeue()?.id, SECOND_QUEUE_ID);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SafeStorage KEK adapter refuses to start without OS protected storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "laundry-persistent-queue-"));
  try {
    assert.throws(
      () =>
        new SafeStorageKekStore(root, {
          ...fakeSafeStorage,
          isEncryptionAvailable: () => false,
        }),
      /protected storage encryption is unavailable/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
