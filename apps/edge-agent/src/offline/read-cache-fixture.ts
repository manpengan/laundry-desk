import { generateKeyPairSync, sign } from "node:crypto";
import {
  DesktopQueryExecuteResultSchema,
  DesktopSessionViewSchema,
  canonicalizeOfflineGrantForSigning,
  createOfflineGrantRegistrySnapshot,
  type DesktopSessionView,
  type OfflineGrantPayload,
} from "@laundry/contracts";
import { bytesToBase64Url } from "../pairing/device-keys.js";
import { MemoryAuthorityTrustStore } from "../pairing/authority-trust.js";
import type { SafeStorageSurface } from "../queue/safe-storage-kek.js";
import type { VerifiedOfflineReadAuthority } from "./read-authority.js";
import { OfflineReadCache } from "./read-cache.js";
const ORG_ID = "01a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const STORE_ID = "11a2eed0-a6c3-493c-a3a7-20bf94b1d678";
export const STAFF_ID = "21a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const DEVICE_ID = "31a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const SESSION_ID = "41a2eed0-a6c3-493c-a3a7-20bf94b1d678";
const keys = generateKeyPairSync("ed25519");
const registry = createOfflineGrantRegistrySnapshot();

export const safeStorage: SafeStorageSurface = Object.freeze({
  isEncryptionAvailable: () => true,
  encryptString: (plaintext) => Buffer.from(`keychain:${plaintext}`, "utf8"),
  decryptString: (ciphertext) => {
    const text = ciphertext.toString("utf8");
    if (!text.startsWith("keychain:")) throw new Error("missing Keychain item");
    return text.slice("keychain:".length);
  },
});

export function sessionOf(
  overrides: Partial<DesktopSessionView["session"]> = {},
): DesktopSessionView {
  return DesktopSessionViewSchema.parse({
    session: {
      session_id: SESSION_ID,
      session_version: 7,
      org_id: ORG_ID,
      store_id: STORE_ID,
      staff_id: STAFF_ID,
      device_id: DEVICE_ID,
      permission_version: 3,
      ...overrides,
    },
    role: "staff",
    features: { member_enabled: true },
    display: {
      store_name: "本地门店",
      staff_name: "店员",
      org_code: "local",
      store_code: "main",
    },
  });
}

export function authorityFor(
  session: DesktopSessionView,
  issuedAt = "2026-07-30T00:00:00.000Z",
  notAfter = "2026-07-30T12:00:00.000Z",
): VerifiedOfflineReadAuthority {
  const payload: OfflineGrantPayload = Object.freeze({
    grant_id: "51a2eed0-a6c3-493c-a3a7-20bf94b1d678",
    org_id: session.session.org_id,
    store_id: session.session.store_id,
    staff_id: session.session.staff_id,
    device_id: session.session.device_id,
    request_nonce: "61a2eed0-a6c3-493c-a3a7-20bf94b1d678",
    permission_version: session.session.permission_version,
    allowed_commands: Object.freeze(["order.pickup"]),
    issued_at: issuedAt,
    ttl_ms: Date.parse(notAfter) - Date.parse(issuedAt),
    not_after: notAfter,
  });
  const unsigned = Object.freeze({ protocol_version: "1.0.0", payload });
  return Object.freeze({
    serverPublicKeySpki: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    offlineGrant: Object.freeze({
      ...unsigned,
      sig: bytesToBase64Url(
        new Uint8Array(
          sign(null, canonicalizeOfflineGrantForSigning(unsigned, registry), keys.privateKey),
        ),
      ),
    }),
  });
}

export const orderListInput = Object.freeze({
  name: "order.list",
  body: Object.freeze({ status: "open", limit: 20 }),
});
export const orderListResult = DesktopQueryExecuteResultSchema.parse({
  ok: true,
  data: {
    execution: "executed",
    result: {
      orders: [{ order_id: "61a2eed0-a6c3-493c-a3a7-20bf94b1d678", phone: "13800000001" }],
    },
  },
});

export function createCache(root: string, now: () => Date, storage = safeStorage) {
  return new OfflineReadCache({
    rootPath: root,
    safeStorage: storage,
    authorityTrust: new MemoryAuthorityTrustStore(),
    now,
  });
}
