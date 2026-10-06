/** Shared fixtures for the offline runtime tests. */
import { generateKeyPairSync, sign } from "node:crypto";
import {
  DesktopSessionViewSchema,
  EdgeAuthorityDataSchema,
  canonicalizeOfflineGrantForSigning,
  canonicalizePrimaryLeaseForSigning,
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
export const GRANT_ID = "41a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const LEASE_ID = "51a2eed0-a6c3-493c-a3a7-20bf94b1d678";
export const QUEUE_ID = "61a2eed0-a6c3-493c-a3a7-20bf94b1d678";
export const IDEMPOTENCY_ID = "71a2eed0-a6c3-493c-a3a7-20bf94b1d678";
export const AUTHORITY_NONCE = "91a2eed0-a6c3-493c-a3a7-20bf94b1d678";
export const STALE_AUTHORITY_NONCE = "a1a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const registry = createOfflineGrantRegistrySnapshot();
const keys = generateKeyPairSync("ed25519");

export const safeStorage: SafeStorageSurface = Object.freeze({
  isEncryptionAvailable: () => true,
  encryptString: (plaintext) => Buffer.from(`keychain:${plaintext}`, "utf8"),
  decryptString: (ciphertext) => ciphertext.toString("utf8").slice("keychain:".length),
});

export const session = DesktopSessionViewSchema.parse({
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

export function authorityData(
  options: Readonly<{ requestNonce?: string; primaryLease?: boolean }> = {},
) {
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

export function pickupInput() {
  return Object.freeze({
    name: "order.pickup",
    body: Object.freeze({
      order_id: "91a2eed0-a6c3-493c-a3a7-20bf94b1d678",
      garment_ids: [],
      collect_cents: 0,
    }),
  });
}

export function receiveInput(method?: "cash" | "wechat" | "alipay" | "other") {
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

export const grantCommandInputs = Object.freeze([
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

export function perGrantSequence(envelope: EdgeQueueEnvelope): number | null {
  const authorization = envelope.authorization;
  return authorization.kind === "grant" && "per_grant_seq" in authorization
    ? authorization.per_grant_seq
    : null;
}

export function createRuntime(
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
