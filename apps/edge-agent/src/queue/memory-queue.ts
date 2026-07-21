/**
 * Encrypted-at-rest simulation of the offline queue.
 * In-memory map holds **ciphertext blobs only**; DEK stays in process memory;
 * KEK / wrapped DEK via KekStore (OS store in production).
 */

import { randomUUID } from "node:crypto";

import { parseEdgeQueueEnvelope, type EdgeQueueEnvelope } from "@laundry/contracts";

import { decryptAes256Gcm, encryptAes256Gcm, packSealedBlob, unpackSealedBlob } from "./crypto.js";
import {
  generateDek,
  rewrapDek,
  unwrapDek,
  wrapDek,
  type Dek,
  type Kek,
  type KekStore,
} from "./dek-kek.js";
import type { QueueRowState, QueueStoredRecord } from "./store.js";
import {
  QUEUE_STORAGE_VERSION,
  QueueCryptoError,
  type QueueItem,
  type QueueItemId,
  type QueueStatusSnapshot,
} from "./types.js";

type OpenRow = {
  record: QueueStoredRecord;
  state: QueueRowState;
};

export type MemoryEncryptedQueueOptions = Readonly<{
  kekStore: KekStore;
  /** Optional fixed DEK for deterministic tests. */
  dek?: Dek;
}>;

function sealEnvelope(
  dek: Dek,
  id: QueueItemId,
  seq: number,
  envelope: EdgeQueueEnvelope,
): {
  sealedPayload: Buffer;
  aad: string;
} {
  const aad = `laundry.edge.queue.item.v${QUEUE_STORAGE_VERSION}|${id}|${seq}`;
  const plaintext = Buffer.from(JSON.stringify(envelope), "utf8");
  const sealed = encryptAes256Gcm(dek, plaintext, Buffer.from(aad, "utf8"));
  return { sealedPayload: packSealedBlob(sealed), aad };
}

function openEnvelope(dek: Dek, record: QueueStoredRecord): EdgeQueueEnvelope {
  const sealed = unpackSealedBlob(record.sealedPayload);
  const plaintext = decryptAes256Gcm(dek, sealed, Buffer.from(record.aad, "utf8"));
  return parseEdgeQueueEnvelope(JSON.parse(plaintext.toString("utf8")) as unknown);
}

export class MemoryEncryptedQueue {
  private readonly kekStore: KekStore;
  private dek: Dek;
  private seq = 0;
  private readonly rows = new Map<QueueItemId, OpenRow>();

  constructor(options: MemoryEncryptedQueueOptions) {
    this.kekStore = options.kekStore;
    this.dek = this.bootstrapDek(options.dek);
  }

  private bootstrapDek(provided?: Dek): Dek {
    const kek = this.kekStore.getOrCreateKek();
    const existing = this.kekStore.loadWrappedDek();
    if (provided) {
      const wrapped = wrapDek(provided, kek, Math.max(1, this.kekStore.currentKeyVersion()));
      this.kekStore.saveWrappedDek(wrapped);
      return Buffer.from(provided);
    }
    if (existing) {
      return unwrapDek(existing, kek);
    }
    const dek = generateDek();
    this.kekStore.saveWrappedDek(wrapDek(dek, kek, 1));
    return dek;
  }

  /**
   * Encrypt envelope under DEK and store ciphertext only.
   * Validates against A4 `parseEdgeQueueEnvelope` (fail closed on schema errors).
   */
  enqueue(envelopeInput: unknown, id: QueueItemId = randomUUID(), nowMs = Date.now()): QueueItem {
    const envelope = parseEdgeQueueEnvelope(envelopeInput);
    this.seq += 1;
    const seq = this.seq;
    const { sealedPayload, aad } = sealEnvelope(this.dek, id, seq, envelope);
    const record: QueueStoredRecord = Object.freeze({ id, seq, sealedPayload, aad });
    this.rows.set(id, { record, state: "pending" });
    return Object.freeze({ id, seq, enqueuedAtMs: nowMs, envelope });
  }

  /** Peek next pending item (FIFO by seq), mark inflight, return plaintext. */
  dequeue(): QueueItem | null {
    const next = this.nextPending();
    if (!next) return null;
    const envelope = openEnvelope(this.dek, next.record);
    next.state = "inflight";
    return Object.freeze({
      id: next.record.id,
      seq: next.record.seq,
      enqueuedAtMs: 0,
      envelope,
    });
  }

  /** Remove after successful handling. */
  ack(id: QueueItemId): boolean {
    return this.rows.delete(id);
  }

  /** Debug / integrity: decrypt one stored blob (throws QueueCryptoError on bad MAC). */
  decryptStored(id: QueueItemId): EdgeQueueEnvelope {
    const row = this.rows.get(id);
    if (!row) {
      throw new QueueCryptoError("malformed_blob", `unknown queue id ${id}`);
    }
    return openEnvelope(this.dek, row.record);
  }

  /**
   * Test / attack simulation: overwrite sealed payload (wrong key or tampered CT).
   * Production SQLCipher store would not expose this.
   */
  replaceSealedPayloadForTest(id: QueueItemId, sealedPayload: Buffer): void {
    const row = this.rows.get(id);
    if (!row) throw new Error(`unknown queue id ${id}`);
    row.record = Object.freeze({ ...row.record, sealedPayload: Buffer.from(sealedPayload) });
  }

  /** Expose raw sealed rows for assertions (ciphertext only). */
  listSealed(): readonly QueueStoredRecord[] {
    return [...this.rows.values()].map((r) => r.record).sort((a, b) => a.seq - b.seq);
  }

  status(): QueueStatusSnapshot {
    let pendingCount = 0;
    let inflightCount = 0;
    for (const row of this.rows.values()) {
      if (row.state === "pending") pendingCount += 1;
      else inflightCount += 1;
    }
    const wrapped = this.kekStore.loadWrappedDek();
    return Object.freeze({
      pendingCount,
      inflightCount,
      storageVersion: QUEUE_STORAGE_VERSION,
      hasDek: this.dek.length > 0,
      kekKeyVersion: wrapped?.keyVersion ?? null,
    });
  }

  /**
   * Rotate KEK: rewrap DEK under new KEK; row ciphertext unchanged.
   * `replaceKek` is applied only for MemoryKekStore test path via callback.
   */
  rotateKek(newKek: Kek, applyKek: (kek: Kek) => void): void {
    const wrapped = this.kekStore.loadWrappedDek();
    if (!wrapped) {
      throw new QueueCryptoError("missing_dek", "no wrapped DEK to rewrap");
    }
    const oldKek = this.kekStore.getOrCreateKek();
    const nextVersion = wrapped.keyVersion + 1;
    const rewrapped = rewrapDek(wrapped, oldKek, newKek, nextVersion);
    applyKek(newKek);
    this.kekStore.saveWrappedDek(rewrapped);
  }

  /** Best-effort wipe (unbind). */
  clear(): void {
    this.rows.clear();
    this.dek.fill(0);
    this.kekStore.clear();
  }

  private nextPending(): OpenRow | null {
    let best: OpenRow | null = null;
    for (const row of this.rows.values()) {
      if (row.state !== "pending") continue;
      if (!best || row.record.seq < best.record.seq) best = row;
    }
    return best;
  }
}
