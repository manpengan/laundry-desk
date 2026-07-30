import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import {
  EdgeAuthorityDataSchema,
  canonicalizeOfflineGrantForSigning,
  canonicalizePrimaryLeaseForSigning,
  createOfflineGrantRegistrySnapshot,
  type EdgeAuthorityData,
  type OfflineGrantPayload,
  type PrimaryLeasePayload,
} from "@laundry/contracts";

import type { AuthorizedSession } from "../auth/session-view.js";

const PROTOCOL_VERSION = "1.0.0";
const GRANT_TTL_MS = 5 * 60 * 1_000;
const LEASE_TTL_MS = 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 2_000;
const ALLOWED_COMMANDS = Object.freeze([
  "order.receive",
  "order.hold",
  "order.pickup",
  "payment.collect",
  "payment.repay",
] as const);

type ActivePrimary = Readonly<{
  device_id: string;
  primary_epoch: number;
  not_after_ms: number;
}>;

export type EdgeAuthorityService = Readonly<{
  issue: (session: AuthorizedSession) => EdgeAuthorityData | null;
}>;

function exactTime(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function signGrant(payload: OfflineGrantPayload, privateKey: KeyObject) {
  const authority = Object.freeze({ protocol_version: PROTOCOL_VERSION, payload });
  const message = canonicalizeOfflineGrantForSigning(
    authority,
    createOfflineGrantRegistrySnapshot(),
  );
  return Object.freeze({
    ...authority,
    sig: sign(null, message, privateKey).toString("base64url"),
  });
}

function signLease(payload: PrimaryLeasePayload, privateKey: KeyObject) {
  const authority = Object.freeze({ protocol_version: PROTOCOL_VERSION, payload });
  const message = canonicalizePrimaryLeaseForSigning(authority);
  return Object.freeze({
    ...authority,
    sig: sign(null, message, privateKey).toString("base64url"),
  });
}

export function createEdgeAuthorityService(
  options: Readonly<{
    now?: () => number;
    randomUUID: () => string;
    keyPair?: Readonly<{ publicKey: KeyObject; privateKey: KeyObject }>;
  }>,
): EdgeAuthorityService {
  const now = options.now ?? Date.now;
  const keyPair = options.keyPair ?? generateKeyPairSync("ed25519");
  if (
    keyPair.privateKey.asymmetricKeyType !== "ed25519" ||
    keyPair.publicKey.asymmetricKeyType !== "ed25519"
  ) {
    throw new Error("Edge authority service requires Ed25519 keys");
  }
  const primaryByStore = new Map<string, ActivePrimary>();
  let nextEpoch = 1;

  return Object.freeze({
    issue: (session) => {
      const issuedAtMs = now();
      const storeId = session.session.store_id;
      const deviceId = session.session.device_id;
      const current = primaryByStore.get(storeId);
      if (
        current !== undefined &&
        current.not_after_ms > issuedAtMs &&
        current.device_id !== deviceId
      ) {
        return null;
      }
      const primaryEpoch =
        current !== undefined && current.device_id === deviceId
          ? current.primary_epoch
          : nextEpoch++;
      const grant: OfflineGrantPayload = Object.freeze({
        grant_id: options.randomUUID(),
        org_id: session.session.org_id,
        store_id: storeId,
        staff_id: session.session.staff_id,
        device_id: deviceId,
        permission_version: session.session.permission_version,
        allowed_commands: ALLOWED_COMMANDS,
        issued_at: exactTime(issuedAtMs),
        ttl_ms: GRANT_TTL_MS,
        not_after: exactTime(issuedAtMs + GRANT_TTL_MS),
      });
      const lease: PrimaryLeasePayload = Object.freeze({
        lease_id: options.randomUUID(),
        store_id: storeId,
        device_id: deviceId,
        primary_epoch: primaryEpoch,
        issued_at: exactTime(issuedAtMs),
        ttl_ms: LEASE_TTL_MS,
        max_clock_skew_ms: MAX_CLOCK_SKEW_MS,
        not_after: exactTime(issuedAtMs + LEASE_TTL_MS),
      });
      primaryByStore.set(
        storeId,
        Object.freeze({
          device_id: deviceId,
          primary_epoch: primaryEpoch,
          not_after_ms: issuedAtMs + LEASE_TTL_MS,
        }),
      );
      return Object.freeze(
        EdgeAuthorityDataSchema.parse({
          server_public_key_spki: keyPair.publicKey
            .export({ type: "spki", format: "der" })
            .toString("base64"),
          offline_grant: signGrant(grant, keyPair.privateKey),
          primary_lease: signLease(lease, keyPair.privateKey),
        }),
      );
    },
  });
}
