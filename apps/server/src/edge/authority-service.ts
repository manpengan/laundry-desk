import { createHash, randomBytes, randomInt, type KeyObject } from "node:crypto";

import {
  EdgeAuthorityChallengeDataSchema,
  EdgeAuthorityChallengeRequestSchema,
  EdgeAuthorityChallengeSchema,
  EdgeAuthorityDataSchema,
  EdgePairingCodeSchema,
  OFFLINE_GRANT_MAX_TTL_MS,
  type EdgeAuthorityChallengeData,
  type EdgeAuthorityChallengeRequest,
  type EdgeAuthorityData,
  type EdgeAuthorityRequest,
} from "@laundry/contracts";

import type { AuthorizedSession } from "../auth/session-view.js";
import type { EdgeAuthorityStore } from "./authority-store.js";
import {
  assertAuthorityKeyPair,
  derivePairingHashKey,
  hashPairingCode,
  parseAuthorityDeviceKey,
  signAuthorityGrant,
  signAuthorityLease,
  verifyAuthorityDeviceProof,
} from "./authority-crypto.js";

const DEFAULT_CHALLENGE_TTL_MS = 60 * 1_000;
const MAX_CHALLENGE_TTL_MS = 60 * 1_000;
const DEFAULT_GRANT_TTL_MS = OFFLINE_GRANT_MAX_TTL_MS;
const DEFAULT_LEASE_TTL_MS = 60 * 1_000;
const DEFAULT_MAX_CLOCK_SKEW_MS = 2_000;
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const ALLOWED_COMMANDS = Object.freeze([
  "order.receive",
  "order.hold",
  "order.pickup",
  "payment.collect",
  "payment.repay",
] as const);

export type EdgeAuthorityService = Readonly<{
  challenge: (
    session: AuthorizedSession,
    request: EdgeAuthorityChallengeRequest,
  ) => Promise<EdgeAuthorityChallengeData | null>;
  issue: (
    session: AuthorizedSession,
    request: EdgeAuthorityRequest,
  ) => Promise<EdgeAuthorityData | null>;
}>;

type EdgeAuthorityServiceOptions = Readonly<{
  store: EdgeAuthorityStore;
  randomUUID: () => string;
  keyPair: Readonly<{ publicKey: KeyObject; privateKey: KeyObject }>;
  randomChallenge?: () => string;
  randomPairingCode?: () => string;
  challengeTtlMs?: number;
  grantTtlMs?: number;
  leaseTtlMs?: number;
  maxClockSkewMs?: number;
}>;

function requireInteger(value: number, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${field} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function exactTime(date: Date, offsetMs = 0): string {
  const epochMs = date.getTime() + offsetMs;
  if (!Number.isFinite(epochMs)) throw new TypeError("Authority timestamp is out of range");
  return new Date(epochMs).toISOString();
}

function canManageAuthority(session: AuthorizedSession): boolean {
  return (
    session.session.status === "active" &&
    session.authority.role === "admin" &&
    (session.session.authentication_method === "password" ||
      session.session.authentication_method === "pin")
  );
}

export function createEdgeAuthorityService(
  options: EdgeAuthorityServiceOptions,
): EdgeAuthorityService {
  const keyPair = options.keyPair;
  assertAuthorityKeyPair(keyPair);
  const challengeTtlMs = requireInteger(
    options.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS,
    "challengeTtlMs",
    1,
    MAX_CHALLENGE_TTL_MS,
  );
  const grantTtlMs = requireInteger(
    options.grantTtlMs ?? DEFAULT_GRANT_TTL_MS,
    "grantTtlMs",
    1,
    OFFLINE_GRANT_MAX_TTL_MS,
  );
  const leaseTtlMs = requireInteger(
    options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
    "leaseTtlMs",
    1,
    POSTGRES_INTEGER_MAX,
  );
  const maxClockSkewMs = requireInteger(
    options.maxClockSkewMs ?? DEFAULT_MAX_CLOCK_SKEW_MS,
    "maxClockSkewMs",
    0,
    POSTGRES_INTEGER_MAX,
  );
  const serverPublicKeySpki = keyPair.publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64");
  const pairingHashKey = derivePairingHashKey(keyPair.privateKey);

  return Object.freeze({
    challenge: async (session, requestInput) => {
      const request = EdgeAuthorityChallengeRequestSchema.safeParse(requestInput);
      if (!request.success) return null;
      const deviceKey = parseAuthorityDeviceKey(request.data.device_public_key_spki);
      if (deviceKey === null) return null;
      const challenge = EdgeAuthorityChallengeSchema.parse(
        options.randomChallenge?.() ?? randomBytes(32).toString("base64url"),
      );
      const pairingCode = EdgePairingCodeSchema.parse(
        options.randomPairingCode?.() ?? randomInt(0, 1_000_000).toString().padStart(6, "0"),
      );
      const challengeId = options.randomUUID();
      const authorityManager = canManageAuthority(session);
      const hashBinding = Object.freeze({
        orgId: session.session.org_id,
        storeId: session.session.store_id,
        sessionId: session.session.session_id,
        deviceId: session.session.device_id,
        requestNonce: request.data.request_nonce,
        devicePublicKeySpki: deviceKey.spkiBase64Url,
      });
      const stored = await options.store.createChallenge({
        canPairDevice: authorityManager,
        canPromotePrimary: authorityManager,
        role: session.authority.role,
        authenticationMethod: session.session.authentication_method,
        orgId: session.session.org_id,
        storeId: session.session.store_id,
        staffId: session.session.staff_id,
        sessionId: session.session.session_id,
        sessionVersion: session.session.session_version,
        permissionVersion: session.session.permission_version,
        deviceId: session.session.device_id,
        devicePublicKeySpki: deviceKey.spkiBase64Url,
        devicePublicKeyFingerprint: deviceKey.fingerprint,
        challengeId,
        challengeSha256: createHash("sha256").update(challenge, "utf8").digest("hex"),
        requestNonce: request.data.request_nonce,
        requestPrimary: request.data.request_primary,
        pairingCodeHash: hashPairingCode(pairingHashKey, pairingCode, hashBinding),
        ttlMs: challengeTtlMs,
      });
      if (stored === null) return null;
      return Object.freeze(
        EdgeAuthorityChallengeDataSchema.parse({
          org_id: session.session.org_id,
          store_id: session.session.store_id,
          staff_id: session.session.staff_id,
          session_id: session.session.session_id,
          session_version: session.session.session_version,
          permission_version: session.session.permission_version,
          device_id: session.session.device_id,
          challenge_id: challengeId,
          challenge,
          request_nonce: request.data.request_nonce,
          pairing_code: stored.pairingCodeRequired ? pairingCode : null,
          expires_at: exactTime(stored.expiresAt),
        }),
      );
    },
    issue: async (session, request) => {
      const deviceKey = verifyAuthorityDeviceProof(session, request);
      if (deviceKey === null) return null;
      const authorityManager = canManageAuthority(session);
      const hashBinding = Object.freeze({
        orgId: session.session.org_id,
        storeId: session.session.store_id,
        sessionId: session.session.session_id,
        deviceId: session.session.device_id,
        requestNonce: deviceKey.requestNonce,
        devicePublicKeySpki: deviceKey.spkiBase64Url,
      });
      const stored = await options.store.issue({
        canPairDevice: authorityManager,
        canPromotePrimary: authorityManager,
        role: session.authority.role,
        authenticationMethod: session.session.authentication_method,
        orgId: session.session.org_id,
        storeId: session.session.store_id,
        staffId: session.session.staff_id,
        sessionId: session.session.session_id,
        sessionVersion: session.session.session_version,
        deviceId: session.session.device_id,
        permissionVersion: session.session.permission_version,
        challengeId: deviceKey.challengeId,
        challengeSha256: deviceKey.challengeSha256,
        requestNonce: deviceKey.requestNonce,
        requestPrimary: deviceKey.requestPrimary,
        pairingCodeHash:
          deviceKey.pairingCode === null
            ? null
            : hashPairingCode(pairingHashKey, deviceKey.pairingCode, hashBinding),
        devicePublicKeySpki: deviceKey.spkiBase64Url,
        devicePublicKeyFingerprint: deviceKey.fingerprint,
        createGrant: (issuedAt) =>
          signAuthorityGrant(
            Object.freeze({
              grant_id: options.randomUUID(),
              org_id: session.session.org_id,
              store_id: session.session.store_id,
              staff_id: session.session.staff_id,
              device_id: session.session.device_id,
              request_nonce: deviceKey.requestNonce,
              permission_version: session.session.permission_version,
              allowed_commands: ALLOWED_COMMANDS,
              issued_at: exactTime(issuedAt),
              ttl_ms: grantTtlMs,
              not_after: exactTime(issuedAt, grantTtlMs),
            }),
            keyPair.privateKey,
          ),
        createLease: (issuedAt, primaryEpoch, grantId) =>
          signAuthorityLease(
            Object.freeze({
              lease_id: options.randomUUID(),
              grant_id: grantId,
              org_id: session.session.org_id,
              store_id: session.session.store_id,
              device_id: session.session.device_id,
              primary_epoch: primaryEpoch,
              issued_at: exactTime(issuedAt),
              ttl_ms: leaseTtlMs,
              max_clock_skew_ms: maxClockSkewMs,
              not_after: exactTime(issuedAt, leaseTtlMs),
            }),
            keyPair.privateKey,
          ),
        createAuditId: options.randomUUID,
      });
      if (stored === null) return null;
      return Object.freeze(
        EdgeAuthorityDataSchema.parse({
          server_public_key_spki: serverPublicKeySpki,
          offline_grant: stored.offlineGrant,
          primary_lease: stored.primaryLease,
        }),
      );
    },
  });
}
