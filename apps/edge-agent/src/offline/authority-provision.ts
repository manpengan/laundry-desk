import { createPublicKey } from "node:crypto";

import {
  createOfflineGrantRegistrySnapshot,
  type DesktopSessionView,
  type EdgeAuthorityData,
} from "@laundry/contracts";

import { OfflineAuthorizationGuard, type MonotonicClock } from "../lease/primary-lease.js";
import type { AuthorityTrustStore } from "../pairing/authority-trust.js";
import {
  bindAuthoritySession,
  bindReadAuthoritySession,
  type AuthoritySessionBinding,
  type ReadAuthoritySessionBinding,
} from "./authority-session.js";
import type { OfflineAuthorityDiagnostic } from "./offline-results.js";

const SAFETY_MARGIN_MS = 30_000;

export type ActiveAuthority = Readonly<{
  guard: OfflineAuthorizationGuard;
  binding: AuthoritySessionBinding;
  grantId: string;
  grantDeadlineMonoMs: number;
  primary: Readonly<{
    leaseId: string;
    primaryEpoch: number;
    nextSequence: number;
    leaseDeadlineMonoMs: number;
  }> | null;
}>;

type ProvisionFailure = Extract<
  OfflineAuthorityDiagnostic,
  "authority_grant_fail" | "authority_trust_fail" | "authority_lease_fail"
>;

type PreparedAuthority = Readonly<{
  authority: ActiveAuthority;
  readAuthority: ReadAuthoritySessionBinding;
}>;

export function prepareOfflineAuthority(
  data: EdgeAuthorityData,
  session: DesktopSessionView,
  requestNonce: string,
  clock: MonotonicClock,
  authorityTrust: AuthorityTrustStore,
  authorityRoundTripMs: number,
):
  | Readonly<{ ok: true; data: PreparedAuthority }>
  | Readonly<{ ok: false; reason: ProvisionFailure }> {
  const failure = (reason: ProvisionFailure) => Object.freeze({ ok: false as const, reason });
  try {
    if (!Number.isFinite(authorityRoundTripMs) || authorityRoundTripMs < 0) {
      return failure("authority_grant_fail");
    }
    const publicKey = createPublicKey({
      key: Buffer.from(data.server_public_key_spki, "base64"),
      format: "der",
      type: "spki",
    });
    const guard = new OfflineAuthorizationGuard({
      serverPublicKey: publicKey,
      registrySnapshot: createOfflineGrantRegistrySnapshot(),
      orgId: session.session.org_id,
      storeId: session.session.store_id,
      staffId: session.session.staff_id,
      deviceId: session.session.device_id,
      permissionVersion: session.session.permission_version,
      clock,
      safetyMarginMs: SAFETY_MARGIN_MS + authorityRoundTripMs,
    });
    const grantRequest = guard.startAuthorityRequest(requestNonce);
    if (!grantRequest.ok) return failure("authority_grant_fail");
    const grant = guard.acceptOfflineGrant(data.offline_grant, grantRequest.request);
    if (!grant.ok) return failure("authority_grant_fail");
    try {
      if (!authorityTrust.accept(publicKey)) return failure("authority_trust_fail");
    } catch {
      return failure("authority_trust_fail");
    }
    const readAuthority = bindReadAuthoritySession(session, data);
    const baseAuthority: ActiveAuthority = Object.freeze({
      guard,
      binding: bindAuthoritySession(session),
      grantId: data.offline_grant.payload.grant_id,
      grantDeadlineMonoMs: grant.localDeadlineMonoMs,
      primary: null,
    });
    if (data.primary_lease === null) {
      return Object.freeze({
        ok: true,
        data: Object.freeze({ authority: baseAuthority, readAuthority }),
      });
    }
    const leaseRequest = guard.startAuthorityRequest(requestNonce);
    if (!leaseRequest.ok) return failure("authority_lease_fail");
    const lease = guard.acceptPrimaryLease(data.primary_lease, leaseRequest.request);
    if (!lease.ok) return failure("authority_lease_fail");
    const authority: ActiveAuthority = Object.freeze({
      ...baseAuthority,
      primary: Object.freeze({
        leaseId: data.primary_lease.payload.lease_id,
        primaryEpoch: data.primary_lease.payload.primary_epoch,
        nextSequence: 1,
        leaseDeadlineMonoMs: lease.localDeadlineMonoMs,
      }),
    });
    return Object.freeze({ ok: true, data: Object.freeze({ authority, readAuthority }) });
  } catch {
    return failure("authority_grant_fail");
  }
}
