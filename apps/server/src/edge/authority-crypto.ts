import { createHash, createHmac, createPublicKey, sign, verify, type KeyObject } from "node:crypto";

import {
  EdgeAuthorityRequestSchema,
  SignedOfflineGrantSchema,
  SignedPrimaryLeaseSchema,
  canonicalizeEdgeDeviceRegistrationForSigning,
  canonicalizeOfflineGrantForSigning,
  canonicalizePrimaryLeaseForSigning,
  createOfflineGrantRegistrySnapshot,
  type EdgeAuthorityRequest,
  type OfflineGrantPayload,
  type PrimaryLeasePayload,
} from "@laundry/contracts";

import type { AuthorizedSession } from "../auth/session-view.js";
import type { SignedOfflineGrant, SignedPrimaryLease } from "./authority-store.js";

export const AUTHORITY_PROTOCOL_VERSION = "1.0.0";

export type AuthorityDeviceKey = Readonly<{
  publicKey: KeyObject;
  spkiBase64Url: string;
  fingerprint: string;
}>;

export type VerifiedAuthorityDeviceKey = Readonly<{
  spkiBase64Url: string;
  fingerprint: string;
  challengeId: string;
  challengeSha256: string;
  requestNonce: string;
  requestPrimary: boolean;
  pairingCode: string | null;
}>;

export type PairingHashBinding = Readonly<{
  orgId: string;
  storeId: string;
  sessionId: string;
  deviceId: string;
  requestNonce: string;
  devicePublicKeySpki: string;
}>;

export function assertAuthorityKeyPair(
  keyPair: Readonly<{ publicKey: KeyObject; privateKey: KeyObject }>,
): void {
  if (
    keyPair.privateKey.asymmetricKeyType !== "ed25519" ||
    keyPair.publicKey.asymmetricKeyType !== "ed25519"
  ) {
    throw new Error("Edge authority service requires Ed25519 keys");
  }
  const probe = Buffer.from("laundry.edge.authority-key-check", "utf8");
  if (!verify(null, probe, keyPair.publicKey, sign(null, probe, keyPair.privateKey))) {
    throw new Error("Edge authority public and private keys do not match");
  }
}

export function parseAuthorityDeviceKey(spkiBase64Url: string): AuthorityDeviceKey | null {
  try {
    const spkiBytes = Buffer.from(spkiBase64Url, "base64url");
    if (spkiBytes.toString("base64url") !== spkiBase64Url) return null;
    const publicKey = createPublicKey({ key: spkiBytes, format: "der", type: "spki" });
    if (
      publicKey.asymmetricKeyType !== "ed25519" ||
      publicKey.export({ format: "der", type: "spki" }).toString("base64url") !== spkiBase64Url
    ) {
      return null;
    }
    return Object.freeze({
      publicKey,
      spkiBase64Url,
      fingerprint: createHash("sha256").update(spkiBytes).digest("hex"),
    });
  } catch {
    return null;
  }
}

export function derivePairingHashKey(privateKey: KeyObject): Buffer {
  return createHash("sha256")
    .update("laundry.edge.pairing-code.hash-key.v1\0", "utf8")
    .update(privateKey.export({ type: "pkcs8", format: "der" }))
    .digest();
}

export function hashPairingCode(
  hashKey: Buffer,
  code: string,
  binding: PairingHashBinding,
): string {
  const encodedBinding = JSON.stringify([
    binding.orgId,
    binding.storeId,
    binding.sessionId,
    binding.deviceId,
    binding.requestNonce,
    binding.devicePublicKeySpki,
    code,
  ]);
  return createHmac("sha256", hashKey)
    .update("laundry.edge.pairing-code.v1\0", "utf8")
    .update(encodedBinding, "utf8")
    .digest("hex");
}

export function verifyAuthorityDeviceProof(
  session: AuthorizedSession,
  requestInput: EdgeAuthorityRequest,
): VerifiedAuthorityDeviceKey | null {
  const parsed = EdgeAuthorityRequestSchema.safeParse(requestInput);
  if (
    !parsed.success ||
    parsed.data.protocol_version !== AUTHORITY_PROTOCOL_VERSION ||
    parsed.data.payload.org_id !== session.session.org_id ||
    parsed.data.payload.store_id !== session.session.store_id ||
    parsed.data.payload.staff_id !== session.session.staff_id ||
    parsed.data.payload.session_id !== session.session.session_id ||
    parsed.data.payload.session_version !== session.session.session_version ||
    parsed.data.payload.permission_version !== session.session.permission_version ||
    parsed.data.payload.device_id !== session.session.device_id
  ) {
    return null;
  }
  try {
    const deviceKey = parseAuthorityDeviceKey(parsed.data.payload.device_public_key_spki);
    if (deviceKey === null) return null;
    const authority = Object.freeze({
      protocol_version: parsed.data.protocol_version,
      payload: parsed.data.payload,
    });
    if (
      !verify(
        null,
        canonicalizeEdgeDeviceRegistrationForSigning(authority),
        deviceKey.publicKey,
        Buffer.from(parsed.data.sig, "base64url"),
      )
    ) {
      return null;
    }
    return Object.freeze({
      spkiBase64Url: deviceKey.spkiBase64Url,
      fingerprint: deviceKey.fingerprint,
      challengeId: parsed.data.payload.challenge_id,
      challengeSha256: createHash("sha256")
        .update(parsed.data.payload.challenge, "utf8")
        .digest("hex"),
      requestNonce: parsed.data.payload.request_nonce,
      requestPrimary: parsed.data.payload.request_primary,
      pairingCode: parsed.data.payload.pairing_code,
    });
  } catch {
    return null;
  }
}

export function signAuthorityGrant(
  payload: OfflineGrantPayload,
  privateKey: KeyObject,
): SignedOfflineGrant {
  const authority = Object.freeze({ protocol_version: AUTHORITY_PROTOCOL_VERSION, payload });
  const message = canonicalizeOfflineGrantForSigning(
    authority,
    createOfflineGrantRegistrySnapshot(),
  );
  return SignedOfflineGrantSchema.parse({
    ...authority,
    sig: sign(null, message, privateKey).toString("base64url"),
  });
}

export function signAuthorityLease(
  payload: PrimaryLeasePayload,
  privateKey: KeyObject,
): SignedPrimaryLease {
  const authority = Object.freeze({ protocol_version: AUTHORITY_PROTOCOL_VERSION, payload });
  const message = canonicalizePrimaryLeaseForSigning(authority);
  return SignedPrimaryLeaseSchema.parse({
    ...authority,
    sig: sign(null, message, privateKey).toString("base64url"),
  });
}
