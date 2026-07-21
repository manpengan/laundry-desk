import assert from "node:assert/strict";
import test from "node:test";

import { encryptAes256Gcm, packSealedBlob, randomKey } from "./crypto.js";
import { generateKek, MemoryKekStore } from "./dek-kek.js";
import { MemoryEncryptedQueue } from "./memory-queue.js";
import { DEFAULT_QUEUE_ENVELOPE_VERSION, QueueCryptoError } from "./types.js";

const grantId = "f7c4b945-2f08-41f3-b8da-b1af3f7ac547";
const queueIdA = "32ff7821-0b72-4f9c-8ec6-8d7e08500e04";
const queueIdB = "42ff7821-0b72-4f9c-8ec6-8d7e08500e05";

function sampleEnvelope(queueId: string, command = "orders.collect_offline") {
  return {
    queue_envelope_version: DEFAULT_QUEUE_ENVELOPE_VERSION,
    contracts_major: 0,
    queue_id: queueId,
    enqueued_at: "2026-07-21T01:02:03.000Z",
    payload: {
      command,
      version: "1.0.0",
      mode: "direct",
      args: { order_id: "936da01f-9abd-4d9d-80c7-02af85c822a8" },
      idempotency_key: "9dfc4424-9b9a-4e52-baaa-c02868f8e7de",
      dry_run: false,
    },
    authorization: {
      kind: "grant" as const,
      grant_id: grantId,
    },
  };
}

test("enqueue stores ciphertext only (no plaintext envelope fields)", () => {
  const queue = new MemoryEncryptedQueue({ kekStore: new MemoryKekStore() });
  const item = queue.enqueue(sampleEnvelope(queueIdA));
  const sealed = queue.listSealed();
  assert.equal(sealed.length, 1);
  assert.equal(sealed[0]?.id, item.id);
  const blobText = sealed[0]!.sealedPayload.toString("utf8");
  assert.equal(blobText.includes("orders.collect_offline"), false);
  assert.equal(blobText.includes(grantId), false);
  assert.equal(queue.status().pendingCount, 1);
  assert.equal(queue.status().hasDek, true);
});

test("dequeue is FIFO by seq; ack removes", () => {
  const queue = new MemoryEncryptedQueue({ kekStore: new MemoryKekStore() });
  const first = queue.enqueue(sampleEnvelope(queueIdA), "id-a");
  const second = queue.enqueue(sampleEnvelope(queueIdB), "id-b");
  assert.ok(first.seq < second.seq);

  const d1 = queue.dequeue();
  assert.equal(d1?.id, "id-a");
  assert.equal(d1?.envelope.queue_id, queueIdA);
  assert.equal(queue.status().inflightCount, 1);
  assert.equal(queue.status().pendingCount, 1);

  const d2 = queue.dequeue();
  assert.equal(d2?.id, "id-b");
  assert.equal(queue.dequeue(), null);

  assert.equal(queue.ack("id-a"), true);
  assert.equal(queue.ack("id-b"), true);
  assert.equal(queue.ack("missing"), false);
  assert.equal(queue.status().pendingCount, 0);
  assert.equal(queue.status().inflightCount, 0);
});

test("tampered ciphertext fails closed on decrypt", () => {
  const queue = new MemoryEncryptedQueue({ kekStore: new MemoryKekStore() });
  const item = queue.enqueue(sampleEnvelope(queueIdA));
  const row = queue.listSealed()[0];
  assert.ok(row);
  const corrupt = Buffer.from(row.sealedPayload);
  const last = corrupt.length - 1;
  const tail = corrupt[last];
  assert.ok(tail !== undefined);
  corrupt[last] = tail ^ 0xaa;
  queue.replaceSealedPayloadForTest(item.id, corrupt);
  assert.throws(
    () => queue.decryptStored(item.id),
    (err: unknown) => err instanceof QueueCryptoError && err.code === "auth_tag_invalid",
  );
  assert.throws(
    () => queue.dequeue(),
    (err: unknown) => err instanceof QueueCryptoError && err.code === "auth_tag_invalid",
  );
});

test("wrong DEK cannot open items (fresh queue different key)", () => {
  const storeA = new MemoryKekStore();
  const q1 = new MemoryEncryptedQueue({ kekStore: storeA });
  const item = q1.enqueue(sampleEnvelope(queueIdA), "shared-id");
  const sealed = q1.listSealed()[0]!;

  const q2 = new MemoryEncryptedQueue({ kekStore: new MemoryKekStore(), dek: randomKey() });
  // inject foreign ciphertext under a known aad shape via test hook after enqueue
  q2.enqueue(sampleEnvelope(queueIdB), "other");
  q2.replaceSealedPayloadForTest("other", sealed.sealedPayload);
  // AAD still binds id|seq of "other" — even if CT were re-used, MAC fails
  assert.throws(() => q2.decryptStored("other"), QueueCryptoError);
  assert.ok(item.id);
});

test("KEK rotate rewrap path keeps items decryptable under same DEK", () => {
  const kekStore = new MemoryKekStore();
  const queue = new MemoryEncryptedQueue({ kekStore });
  queue.enqueue(sampleEnvelope(queueIdA), "keep-me");
  const beforeVersion = queue.status().kekKeyVersion;
  assert.equal(beforeVersion, 1);

  const newKek = generateKek();
  queue.rotateKek(newKek, (kek) => kekStore.replaceKek(kek));
  assert.equal(queue.status().kekKeyVersion, 2);

  const item = queue.dequeue();
  assert.equal(item?.id, "keep-me");
  assert.equal(item?.envelope.queue_id, queueIdA);
});

test("status never exposes key material fields", () => {
  const queue = new MemoryEncryptedQueue({ kekStore: new MemoryKekStore() });
  queue.enqueue(sampleEnvelope(queueIdA));
  const snap = queue.status();
  const keys = Object.keys(snap).sort();
  assert.deepEqual(keys, [
    "hasDek",
    "inflightCount",
    "kekKeyVersion",
    "pendingCount",
    "storageVersion",
  ]);
  assert.equal(typeof snap.hasDek, "boolean");
  assert.equal(typeof snap.kekKeyVersion, "number");
});

test("foreign sealed blob with matching length still fails without correct DEK", () => {
  const queue = new MemoryEncryptedQueue({ kekStore: new MemoryKekStore() });
  const item = queue.enqueue(sampleEnvelope(queueIdA));
  const foreign = packSealedBlob(
    encryptAes256Gcm(randomKey(), Buffer.from("{}"), Buffer.from(queue.listSealed()[0]!.aad)),
  );
  queue.replaceSealedPayloadForTest(item.id, foreign);
  assert.throws(() => queue.decryptStored(item.id), QueueCryptoError);
});
