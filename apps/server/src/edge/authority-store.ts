import type { EdgeAuthorityData } from "@laundry/contracts";

export type SignedOfflineGrant = EdgeAuthorityData["offline_grant"];
export type SignedPrimaryLease = NonNullable<EdgeAuthorityData["primary_lease"]>;

export type AuthorityActor = Readonly<{
  canPairDevice: boolean;
  canPromotePrimary: boolean;
  role: "admin" | "staff";
  authenticationMethod: "password" | "pin" | "refresh";
}>;

export type AuthorityStoreChallengeInput = Readonly<
  AuthorityActor & {
    orgId: string;
    storeId: string;
    staffId: string;
    sessionId: string;
    sessionVersion: number;
    permissionVersion: number;
    deviceId: string;
    devicePublicKeySpki: string;
    devicePublicKeyFingerprint: string;
    challengeId: string;
    challengeSha256: string;
    requestNonce: string;
    requestPrimary: boolean;
    pairingCodeHash: string;
    ttlMs: number;
  }
>;

export type AuthorityStoreChallengeResult = Readonly<{
  expiresAt: Date;
  pairingCodeRequired: boolean;
}>;

export type AuthorityStoreIssueInput = Readonly<
  AuthorityActor & {
    orgId: string;
    storeId: string;
    staffId: string;
    sessionId: string;
    sessionVersion: number;
    deviceId: string;
    permissionVersion: number;
    challengeId: string;
    challengeSha256: string;
    requestNonce: string;
    requestPrimary: boolean;
    pairingCodeHash: string | null;
    devicePublicKeySpki: string;
    devicePublicKeyFingerprint: string;
    createGrant: (issuedAt: Date) => SignedOfflineGrant;
    createLease: (issuedAt: Date, primaryEpoch: number, grantId: string) => SignedPrimaryLease;
    createAuditId: () => string;
  }
>;

export type AuthorityStoreIssueResult = Readonly<{
  offlineGrant: SignedOfflineGrant;
  primaryLease: SignedPrimaryLease | null;
}>;

/**
 * Durable authority boundary. One call binds/checks the device, serializes the
 * store Primary head, and persists the grant plus any newly issued lease.
 */
export interface EdgeAuthorityStore {
  createChallenge(
    input: AuthorityStoreChallengeInput,
  ): Promise<AuthorityStoreChallengeResult | null>;
  issue(input: AuthorityStoreIssueInput): Promise<AuthorityStoreIssueResult | null>;
}
