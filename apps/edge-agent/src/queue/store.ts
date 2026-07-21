/**
 * Persistence port for the offline queue (D3).
 *
 * Production path (future PR — **not** required in CI):
 * SQLCipher-encrypted SQLite opened with the random DEK (from dek-kek.ts).
 * Example sketch (do not enable without native sqlcipher binding + packaging plan):
 *
 *   // import Database from "better-sqlite3-multiple-ciphers";
 *   // const db = new Database(path);
 *   // db.pragma(`key = "x'${dek.toString("hex")}'"`);
 *   // schema: queue_items(id TEXT PK, seq INTEGER, sealed BLOB, aad TEXT, state TEXT)
 *
 * Skeleton deliberately avoids any sqlcipher / better-sqlite3-multiple-ciphers
 * dependency so Windows CI stays green without native rebuilds.
 *
 * Local schema must follow expand → migrate → contract (ADR-08). KEK rotation
 * rewraps DEK only; prefer not to rekey the whole DB on every KEK rotate.
 */

import type { QueueItemId, QueueStatusSnapshot } from "./types.js";

/** Opaque at-rest row: ciphertext only (plus identity / order metadata). */
export type QueueStoredRecord = Readonly<{
  id: QueueItemId;
  seq: number;
  sealedPayload: Buffer;
  /** Must match encrypt-time AAD for decrypt (fail closed otherwise). */
  aad: string;
}>;

export type QueueRowState = "pending" | "inflight";

export interface QueueStore {
  append(record: QueueStoredRecord): void;
  /** FIFO among non-acked items (pending first, then stable seq). */
  listOpen(): readonly (QueueStoredRecord & { state: QueueRowState })[];
  markInflight(id: QueueItemId): void;
  /** Remove after successful server replay / local ack. */
  ack(id: QueueItemId): boolean;
  status(): Pick<QueueStatusSnapshot, "pendingCount" | "inflightCount">;
  clear(): void;
}
