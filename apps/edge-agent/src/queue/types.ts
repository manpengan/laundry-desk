/**
 * Local offline queue types (D3 skeleton).
 * Plaintext payload shape aligns with A4 `EdgeQueueEnvelope` from `@laundry/contracts`.
 */

import type { EdgeQueueEnvelope } from "@laundry/contracts";

/**
 * Local at-rest packaging version for ciphertext blobs.
 * Independent of contracts `queue_envelope_version` (business envelope).
 */
export const QUEUE_STORAGE_VERSION = 1 as const;

/**
 * Default `queue_envelope_version` written by this Edge build when constructing
 * envelopes for tests / local enqueue helpers. Keep in sync with contracts samples.
 */
export const DEFAULT_QUEUE_ENVELOPE_VERSION = 2 as const;

export type QueueItemId = string;

/** In-process plaintext item — never persisted raw; only ciphertext at rest. */
export type QueueItem = Readonly<{
  id: QueueItemId;
  /** Monotonic enqueue order for FIFO dequeue. */
  seq: number;
  enqueuedAtMs: number;
  envelope: EdgeQueueEnvelope;
}>;

/** Renderer-safe status projection — no key material. */
export type QueueStatusSnapshot = Readonly<{
  pendingCount: number;
  inflightCount: number;
  storageVersion: typeof QUEUE_STORAGE_VERSION;
  /** Whether a DEK is loaded in-process (boolean only). */
  hasDek: boolean;
  /** KEK wrap key_version of the wrapped DEK, if any. */
  kekKeyVersion: number | null;
}>;

export type QueueCryptoErrorCode =
  "auth_tag_invalid" | "malformed_blob" | "missing_dek" | "key_length_invalid";

export class QueueCryptoError extends Error {
  readonly code: QueueCryptoErrorCode;

  constructor(code: QueueCryptoErrorCode, message: string) {
    super(message);
    this.name = "QueueCryptoError";
    this.code = code;
  }
}
