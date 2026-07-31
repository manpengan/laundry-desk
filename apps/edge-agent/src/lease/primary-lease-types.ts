import type { OfflineGrantRegistrySnapshot } from "@laundry/contracts";
import type { KeyObject } from "node:crypto";

export type MonotonicClock = Readonly<{
  nowMs(): number;
  continuity(): "trusted" | "uncertain";
}>;

export type OfflineAuthorityGuardOptions = Readonly<{
  serverPublicKey: KeyObject;
  registrySnapshot: OfflineGrantRegistrySnapshot;
  orgId: string;
  storeId: string;
  staffId: string;
  deviceId: string;
  permissionVersion: number;
  clock: MonotonicClock;
  /** Conservative local allowance removed from each signed authority lifetime. */
  safetyMarginMs: number;
}>;

declare const AUTHORITY_REQUEST_BRAND: unique symbol;
export type OfflineAuthorityRequest = Readonly<{ [AUTHORITY_REQUEST_BRAND]: true }>;

export type AuthorityRequestResult =
  | Readonly<{ ok: true; request: OfflineAuthorityRequest }>
  | Readonly<{ ok: false; error: "invalid_request" | "untrusted_continuity" }>;

export type AuthorityAcceptanceResult =
  | Readonly<{ ok: true; localDeadlineMonoMs: number }>
  | Readonly<{
      ok: false;
      error:
        | "bad_signature"
        | "authority_mismatch"
        | "authority_replayed"
        | "deadline_elapsed"
        | "invalid_request"
        | "malformed"
        | "untrusted_continuity"
        | "wrong_audience";
    }>;

export type OfflineAuthorizationResult =
  | Readonly<{
      ok: true;
      command: string;
      mode: "grant" | "primary_lease";
      localDeadlineMonoMs: number;
    }>
  | Readonly<{
      ok: false;
      error:
        | "command_denied"
        | "grant_expired"
        | "grant_mismatch"
        | "grant_required"
        | "lease_expired"
        | "lease_mismatch"
        | "lease_required"
        | "malformed_envelope"
        | "sequence_out_of_order"
        | "sequence_replayed"
        | "untrusted_continuity";
    }>;
