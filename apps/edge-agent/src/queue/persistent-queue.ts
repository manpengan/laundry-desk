import { randomUUID } from "node:crypto";

import { parseEdgeQueueEnvelope, type EdgeQueueEnvelope } from "@laundry/contracts";

import { decryptAes256Gcm, encryptAes256Gcm, packSealedBlob, unpackSealedBlob } from "./crypto.js";
import { generateDek, unwrapDek, wrapDek, type Dek, type KekStore } from "./dek-kek.js";
import type { QueueStore, QueueStoredRecord } from "./store.js";
import {
  QUEUE_STORAGE_VERSION,
  QueueCryptoError,
  type QueueItem,
  type QueueItemId,
  type QueueStatusSnapshot,
} from "./types.js";

export type PersistentEncryptedQueueOptions = Readonly<{
  kekStore: KekStore;
  store: QueueStore;
}>;

function aadFor(id: QueueItemId, seq: number): string {
  return `laundry.edge.queue.item.v${QUEUE_STORAGE_VERSION}|${id}|${seq}`;
}

function seal(dek: Dek, id: QueueItemId, seq: number, envelope: EdgeQueueEnvelope) {
  const aad = aadFor(id, seq);
  const plaintext = Buffer.from(JSON.stringify(envelope), "utf8");
  const encrypted = encryptAes256Gcm(dek, plaintext, Buffer.from(aad, "utf8"));
  return Object.freeze({ aad, sealedPayload: packSealedBlob(encrypted) });
}

function open(dek: Dek, record: QueueStoredRecord): EdgeQueueEnvelope {
  const expectedAad = aadFor(record.id, record.seq);
  if (record.aad !== expectedAad) {
    throw new QueueCryptoError("malformed_blob", "Queue AAD does not match its identity");
  }
  const plaintext = decryptAes256Gcm(
    dek,
    unpackSealedBlob(record.sealedPayload),
    Buffer.from(record.aad, "utf8"),
  );
  try {
    return parseEdgeQueueEnvelope(JSON.parse(plaintext.toString("utf8")) as unknown);
  } finally {
    plaintext.fill(0);
  }
}

export class PersistentEncryptedQueue {
  private readonly kekStore: KekStore;
  private readonly store: QueueStore;
  private readonly dek: Dek;
  private seq: number;

  constructor(options: PersistentEncryptedQueueOptions) {
    this.kekStore = options.kekStore;
    this.store = options.store;
    const kek = options.kekStore.getOrCreateKek();
    const wrapped = options.kekStore.loadWrappedDek();
    if (wrapped === null) {
      this.dek = generateDek();
      options.kekStore.saveWrappedDek(wrapDek(this.dek, kek, 1));
    } else {
      this.dek = unwrapDek(wrapped, kek);
    }
    kek.fill(0);
    this.seq = Math.max(0, ...options.store.listOpen().map((record) => record.seq));
  }

  enqueue(envelopeInput: unknown, id: QueueItemId = randomUUID(), nowMs = Date.now()): QueueItem {
    const envelope = parseEdgeQueueEnvelope(envelopeInput);
    const seq = this.seq + 1;
    const sealed = seal(this.dek, id, seq, envelope);
    this.store.append(
      Object.freeze({
        id,
        seq,
        sealedPayload: sealed.sealedPayload,
        aad: sealed.aad,
      }),
    );
    this.seq = seq;
    return Object.freeze({ id, seq, enqueuedAtMs: nowMs, envelope });
  }

  dequeue(): QueueItem | null {
    const record = this.store.listOpen()[0];
    if (record === undefined) return null;
    const envelope = open(this.dek, record);
    this.store.markInflight(record.id);
    return Object.freeze({
      id: record.id,
      seq: record.seq,
      enqueuedAtMs: Date.parse(envelope.enqueued_at),
      envelope,
    });
  }

  ack(id: QueueItemId): boolean {
    return this.store.ack(id);
  }

  status(): QueueStatusSnapshot {
    const counts = this.store.status();
    return Object.freeze({
      ...counts,
      storageVersion: QUEUE_STORAGE_VERSION,
      hasDek: this.dek.byteLength === 32,
      kekKeyVersion: this.kekStore.loadWrappedDek()?.keyVersion ?? null,
    });
  }

  clear(): void {
    this.store.clear();
    this.dek.fill(0);
    this.kekStore.clear();
  }
}
