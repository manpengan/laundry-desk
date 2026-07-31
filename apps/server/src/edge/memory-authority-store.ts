import { timingSafeEqual } from "node:crypto";

import type {
  AuthorityStoreChallengeInput,
  AuthorityStoreChallengeResult,
  AuthorityStoreIssueInput,
  AuthorityStoreIssueResult,
  EdgeAuthorityStore,
  SignedOfflineGrant,
  SignedPrimaryLease,
} from "./authority-store.js";

type MemoryDevice = Readonly<{
  publicKeySpki: string;
  publicKeyFingerprint: string;
  status: "paired" | "revoked";
  lastSeenAt: string;
}>;

type MemoryHead = Readonly<{
  currentEpoch: number;
  currentLeaseId: string | null;
}>;

type MemoryChallenge = Readonly<{
  challengeId: string;
  staffId: string;
  sessionId: string;
  sessionVersion: number;
  permissionVersion: number;
  deviceId: string;
  devicePublicKeySpki: string;
  devicePublicKeyFingerprint: string;
  challengeSha256: string;
  requestNonce: string;
  requestPrimary: boolean;
  pairingCodeHash: string | null;
  pairingCodeRequired: boolean;
  expectedPrimaryEpoch: number | null;
  expiresAt: string;
  consumedAt: string | null;
}>;

const tenantKey = (orgId: string, storeId: string): string => `${orgId}:${storeId}`;
const deviceKey = (
  input: Pick<AuthorityStoreIssueInput, "orgId" | "storeId" | "deviceId">,
): string => `${tenantKey(input.orgId, input.storeId)}:${input.deviceId}`;

function requireNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("Memory authority clock must return a valid Date");
  }
  return new Date(value.getTime());
}

function leaseEligibleAtMs(lease: SignedPrimaryLease): number {
  return Date.parse(lease.payload.not_after) + lease.payload.max_clock_skew_ms;
}

function hashesEqual(left: string | null, right: string | null): boolean {
  if (left === null || right === null || left.length !== 64 || right.length !== 64) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export type MemoryAuthorityDebugSnapshot = Readonly<{
  challengeCount: number;
  deviceCount: number;
  grantCount: number;
  leaseCount: number;
  auditEvents: readonly string[];
  pairedDeviceIds: readonly string[];
}>;

export type MemoryAuthorityStore = EdgeAuthorityStore &
  Readonly<{ debugSnapshot: () => MemoryAuthorityDebugSnapshot }>;

/** Process-local adapter for unit tests only. */
export function createMemoryAuthorityStore(
  options: Readonly<{ now?: () => Date }> = {},
): MemoryAuthorityStore {
  const now = options.now ?? (() => new Date());
  let devices = new Map<string, MemoryDevice>();
  let heads = new Map<string, MemoryHead>();
  let leases = new Map<string, SignedPrimaryLease>();
  let grants = new Map<string, SignedOfflineGrant>();
  let challenges = new Map<string, MemoryChallenge>();
  let auditEvents: readonly string[] = Object.freeze([]);

  return Object.freeze({
    async createChallenge(
      input: AuthorityStoreChallengeInput,
    ): Promise<AuthorityStoreChallengeResult | null> {
      const issuedAt = requireNow(now);
      const expiresAt = new Date(issuedAt.getTime() + input.ttlMs);
      if (!Number.isFinite(expiresAt.getTime())) {
        throw new TypeError("Memory authority challenge timestamp is out of range");
      }
      const key = deviceKey(input);
      const existingDevice = devices.get(key);
      if (
        existingDevice !== undefined &&
        (existingDevice.status !== "paired" ||
          existingDevice.publicKeySpki !== input.devicePublicKeySpki ||
          existingDevice.publicKeyFingerprint !== input.devicePublicKeyFingerprint)
      ) {
        return null;
      }
      const pairingCodeRequired = existingDevice === undefined;
      if (pairingCodeRequired && !input.canPairDevice) return null;
      if (input.requestPrimary && !input.canPromotePrimary) return null;
      const head = heads.get(tenantKey(input.orgId, input.storeId));
      const nextChallenges = new Map(challenges);
      nextChallenges.set(
        key,
        Object.freeze({
          challengeId: input.challengeId,
          staffId: input.staffId,
          sessionId: input.sessionId,
          sessionVersion: input.sessionVersion,
          permissionVersion: input.permissionVersion,
          deviceId: input.deviceId,
          devicePublicKeySpki: input.devicePublicKeySpki,
          devicePublicKeyFingerprint: input.devicePublicKeyFingerprint,
          challengeSha256: input.challengeSha256,
          requestNonce: input.requestNonce,
          requestPrimary: input.requestPrimary,
          pairingCodeHash: pairingCodeRequired ? input.pairingCodeHash : null,
          pairingCodeRequired,
          expectedPrimaryEpoch: input.requestPrimary ? (head?.currentEpoch ?? 0) : null,
          expiresAt: expiresAt.toISOString(),
          consumedAt: null,
        }),
      );
      challenges = nextChallenges;
      return Object.freeze({ expiresAt, pairingCodeRequired });
    },

    async issue(input: AuthorityStoreIssueInput): Promise<AuthorityStoreIssueResult | null> {
      const issuedAt = requireNow(now);
      const key = deviceKey(input);
      const challenge = challenges.get(key);
      if (
        challenge === undefined ||
        challenge.challengeId !== input.challengeId ||
        challenge.staffId !== input.staffId ||
        challenge.sessionId !== input.sessionId ||
        challenge.sessionVersion !== input.sessionVersion ||
        challenge.permissionVersion !== input.permissionVersion ||
        challenge.deviceId !== input.deviceId ||
        challenge.devicePublicKeySpki !== input.devicePublicKeySpki ||
        challenge.devicePublicKeyFingerprint !== input.devicePublicKeyFingerprint ||
        challenge.challengeSha256 !== input.challengeSha256 ||
        challenge.requestNonce !== input.requestNonce ||
        challenge.requestPrimary !== input.requestPrimary ||
        challenge.consumedAt !== null ||
        issuedAt.getTime() >= Date.parse(challenge.expiresAt)
      ) {
        return null;
      }
      const nextChallenges = new Map(challenges);
      nextChallenges.set(key, Object.freeze({ ...challenge, consumedAt: issuedAt.toISOString() }));
      challenges = nextChallenges;

      if (
        challenge.pairingCodeRequired
          ? !input.canPairDevice || !hashesEqual(challenge.pairingCodeHash, input.pairingCodeHash)
          : input.pairingCodeHash !== null
      ) {
        return null;
      }
      if (challenge.requestPrimary && !input.canPromotePrimary) return null;

      const existingDevice = devices.get(key);
      if (
        existingDevice !== undefined
          ? existingDevice.status !== "paired" ||
            existingDevice.publicKeySpki !== input.devicePublicKeySpki ||
            existingDevice.publicKeyFingerprint !== input.devicePublicKeyFingerprint
          : !challenge.pairingCodeRequired
      ) {
        return null;
      }

      const headKey = tenantKey(input.orgId, input.storeId);
      const head = heads.get(headKey) ?? Object.freeze({ currentEpoch: 0, currentLeaseId: null });
      if (challenge.requestPrimary) {
        if (
          challenge.expectedPrimaryEpoch === null ||
          challenge.expectedPrimaryEpoch !== head.currentEpoch
        ) {
          return null;
        }
        const currentLease =
          head.currentLeaseId === null ? undefined : leases.get(head.currentLeaseId);
        if (currentLease !== undefined && issuedAt.getTime() < leaseEligibleAtMs(currentLease)) {
          return null;
        }
      }

      const firstPair = existingDevice === undefined;
      const nextDevices = new Map(devices);
      nextDevices.set(
        key,
        Object.freeze({
          publicKeySpki: input.devicePublicKeySpki,
          publicKeyFingerprint: input.devicePublicKeyFingerprint,
          status: "paired" as const,
          lastSeenAt: issuedAt.toISOString(),
        }),
      );

      const offlineGrant = input.createGrant(issuedAt);
      const nextGrants = new Map(grants);
      nextGrants.set(offlineGrant.payload.grant_id, offlineGrant);

      devices = nextDevices;
      grants = nextGrants;
      if (firstPair) auditEvents = Object.freeze([...auditEvents, "edge.device.pair"]);

      let primaryLease: SignedPrimaryLease | null = null;
      if (challenge.requestPrimary) {
        primaryLease = input.createLease(
          issuedAt,
          head.currentEpoch + 1,
          offlineGrant.payload.grant_id,
        );
        const nextLeases = new Map(leases);
        nextLeases.set(primaryLease.payload.lease_id, primaryLease);
        leases = nextLeases;
        const nextHeads = new Map(heads);
        nextHeads.set(
          headKey,
          Object.freeze({
            currentEpoch: primaryLease.payload.primary_epoch,
            currentLeaseId: primaryLease.payload.lease_id,
          }),
        );
        heads = nextHeads;
        auditEvents = Object.freeze([...auditEvents, "edge.primary.promote"]);
      }
      return Object.freeze({ offlineGrant, primaryLease });
    },

    debugSnapshot(): MemoryAuthorityDebugSnapshot {
      return Object.freeze({
        challengeCount: challenges.size,
        deviceCount: devices.size,
        grantCount: grants.size,
        leaseCount: leases.size,
        auditEvents: Object.freeze([...auditEvents]),
        pairedDeviceIds: Object.freeze(
          [...devices.keys()].map((key) => key.slice(key.lastIndexOf(":") + 1)),
        ),
      });
    },
  });
}
