/**
 * Edge-side offline authority guard.
 *
 * This module validates signed authority and queue-envelope metadata only. It
 * deliberately does not inspect command arguments or apply domain rules;
 * server replay remains the sole business-authority path.
 */
import {
  canonicalizeForSignatureVerification,
  parseEdgeQueueEnvelope,
  parseServerSignatureOfflineGrantCandidate,
  parseServerSignaturePrimaryLeaseCandidate,
  validateOfflineGrantAllowedCommands,
  type EdgeQueueEnvelope,
  type OfflineGrantPayload,
  type OfflineGrantRegistrySnapshot,
  type PrimaryLeasePayload,
} from "@laundry/contracts";
import { verify, type KeyObject } from "node:crypto";

import { base64UrlToBytes } from "../pairing/device-keys.js";

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
  clock: MonotonicClock;
  /** Conservative local allowance removed from each signed authority lifetime. */
  safetyMarginMs: number;
}>;

type AuthorityRequestRecord = Readonly<{ startedAtMs: number; continuityEpoch: number }>;
type ActiveGrant = Readonly<{ payload: OfflineGrantPayload; deadlineMonoMs: number }>;
type ActiveLease = Readonly<{ payload: PrimaryLeasePayload; deadlineMonoMs: number }>;

declare const AUTHORITY_REQUEST_BRAND: unique symbol;
export type OfflineAuthorityRequest = Readonly<{ [AUTHORITY_REQUEST_BRAND]: true }>;

export type AuthorityRequestResult =
  | Readonly<{ ok: true; request: OfflineAuthorityRequest }>
  | Readonly<{ ok: false; error: "untrusted_continuity" }>;

export type AuthorityAcceptanceResult =
  | Readonly<{ ok: true; localDeadlineMonoMs: number }>
  | Readonly<{
      ok: false;
      error:
        | "bad_signature"
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

const failAcceptance = (
  error: Extract<AuthorityAcceptanceResult, { ok: false }>["error"],
): AuthorityAcceptanceResult => Object.freeze({ ok: false, error });

const failAuthorization = (
  error: Extract<OfflineAuthorizationResult, { ok: false }>["error"],
): OfflineAuthorizationResult => Object.freeze({ ok: false, error });

const isUsableMonotonicTime = (value: number): boolean => Number.isFinite(value) && value >= 0;

const verifyServerSignature = (
  candidate: Parameters<typeof canonicalizeForSignatureVerification>[0],
  key: KeyObject,
): boolean => {
  try {
    return (
      key.asymmetricKeyType === "ed25519" &&
      verify(
        null,
        canonicalizeForSignatureVerification(candidate),
        key,
        base64UrlToBytes(candidate.sig),
      )
    );
  } catch {
    return false;
  }
};

const deadlineFromRequest = (
  startedAtMs: number,
  receivedAtMs: number,
  ttlMs: number,
  safetyMarginMs: number,
): number | null => {
  const deadline = startedAtMs + ttlMs - safetyMarginMs;
  return Number.isFinite(deadline) && receivedAtMs < deadline ? deadline : null;
};

const primaryLeaseKey = (payload: PrimaryLeasePayload): string =>
  `${payload.lease_id}:${payload.primary_epoch}`;

/**
 * Holds only in-process offline authority. A fresh process starts without a
 * grant or lease, so process restart is fail-closed by construction.
 */
export class OfflineAuthorizationGuard {
  private activeGrant: ActiveGrant | null = null;
  private activeLease: ActiveLease | null = null;
  private continuityEpoch = 0;
  private lastMonotonicMs: number | null = null;
  private readonly leaseHighWater = new Map<string, number>();
  private readonly acceptedGrantIds = new Set<string>();
  private readonly acceptedLeaseKeys = new Set<string>();
  private readonly requests = new WeakMap<object, AuthorityRequestRecord>();

  constructor(private readonly options: OfflineAuthorityGuardOptions) {
    if (options.serverPublicKey.asymmetricKeyType !== "ed25519") {
      throw new TypeError("Offline authority verification requires an Ed25519 server public key");
    }
    if (!isUsableMonotonicTime(options.safetyMarginMs)) {
      throw new TypeError("Offline authority safety margin must be a non-negative finite duration");
    }
  }

  /** Call immediately before requesting a fresh grant or lease from the server. */
  startAuthorityRequest(): AuthorityRequestResult {
    const nowMs = this.readTrustedNow();
    if (nowMs === null) return Object.freeze({ ok: false, error: "untrusted_continuity" });
    const request = Object.freeze({}) as OfflineAuthorityRequest;
    this.requests.set(
      request,
      Object.freeze({ startedAtMs: nowMs, continuityEpoch: this.continuityEpoch }),
    );
    return Object.freeze({ ok: true, request });
  }

  acceptOfflineGrant(wire: unknown, request: OfflineAuthorityRequest): AuthorityAcceptanceResult {
    const nowMs = this.readTrustedNow();
    if (nowMs === null) return failAcceptance("untrusted_continuity");
    const requestRecord = this.consumeRequest(request);
    if (requestRecord === null) return failAcceptance("invalid_request");
    try {
      const candidate = parseServerSignatureOfflineGrantCandidate(
        wire,
        this.options.registrySnapshot,
      );
      if (!verifyServerSignature(candidate, this.options.serverPublicKey)) {
        return failAcceptance("bad_signature");
      }
      if (!this.matchesGrantAudience(candidate.payload)) return failAcceptance("wrong_audience");
      if (this.acceptedGrantIds.has(candidate.payload.grant_id)) {
        return failAcceptance("authority_replayed");
      }
      const deadline = deadlineFromRequest(
        requestRecord.startedAtMs,
        nowMs,
        candidate.payload.ttl_ms,
        this.options.safetyMarginMs,
      );
      if (deadline === null) return failAcceptance("deadline_elapsed");
      this.acceptedGrantIds.add(candidate.payload.grant_id);
      this.activeGrant = Object.freeze({ payload: candidate.payload, deadlineMonoMs: deadline });
      return Object.freeze({ ok: true, localDeadlineMonoMs: deadline });
    } catch {
      return failAcceptance("malformed");
    }
  }

  acceptPrimaryLease(wire: unknown, request: OfflineAuthorityRequest): AuthorityAcceptanceResult {
    const nowMs = this.readTrustedNow();
    if (nowMs === null) return failAcceptance("untrusted_continuity");
    const requestRecord = this.consumeRequest(request);
    if (requestRecord === null) return failAcceptance("invalid_request");
    try {
      const candidate = parseServerSignaturePrimaryLeaseCandidate(wire);
      if (!verifyServerSignature(candidate, this.options.serverPublicKey)) {
        return failAcceptance("bad_signature");
      }
      if (!this.matchesLeaseAudience(candidate.payload)) return failAcceptance("wrong_audience");
      const leaseKey = primaryLeaseKey(candidate.payload);
      if (this.acceptedLeaseKeys.has(leaseKey)) return failAcceptance("authority_replayed");
      const safetyMargin = Math.max(
        this.options.safetyMarginMs,
        candidate.payload.max_clock_skew_ms,
      );
      const deadline = deadlineFromRequest(
        requestRecord.startedAtMs,
        nowMs,
        candidate.payload.ttl_ms,
        safetyMargin,
      );
      if (deadline === null) return failAcceptance("deadline_elapsed");
      this.acceptedLeaseKeys.add(leaseKey);
      this.activeLease = Object.freeze({ payload: candidate.payload, deadlineMonoMs: deadline });
      return Object.freeze({ ok: true, localDeadlineMonoMs: deadline });
    } catch {
      return failAcceptance("malformed");
    }
  }

  /** Electron lifecycle hooks must call this after suspend/resume or clock uncertainty. */
  invalidateContinuity(): void {
    this.activeGrant = null;
    this.activeLease = null;
    this.leaseHighWater.clear();
    this.continuityEpoch += 1;
    this.lastMonotonicMs = null;
  }

  /** Validates only contracts metadata, signed authority, and replay sequencing. */
  authorizeQueueEnvelope(input: unknown): OfflineAuthorizationResult {
    const nowMs = this.readTrustedNow();
    if (nowMs === null) return failAuthorization("untrusted_continuity");
    let envelope: EdgeQueueEnvelope;
    try {
      envelope = parseEdgeQueueEnvelope(input);
    } catch {
      return failAuthorization("malformed_envelope");
    }
    const mode = this.offlineModeFor(envelope.payload.command);
    if (mode === null) return failAuthorization("command_denied");
    const grant = this.currentGrant(nowMs);
    if (grant === null)
      return failAuthorization(this.activeGrant ? "grant_expired" : "grant_required");
    if (envelope.authorization.grant_id !== grant.payload.grant_id)
      return failAuthorization("grant_mismatch");
    if (mode === "grant") return this.authorizeGrant(envelope, grant);
    return this.authorizePrimaryLease(envelope, grant, nowMs);
  }

  private readTrustedNow(): number | null {
    const nowMs = this.options.clock.nowMs();
    if (
      !isUsableMonotonicTime(nowMs) ||
      this.options.clock.continuity() !== "trusted" ||
      (this.lastMonotonicMs !== null && nowMs < this.lastMonotonicMs)
    ) {
      this.invalidateContinuity();
      return null;
    }
    this.lastMonotonicMs = nowMs;
    return nowMs;
  }

  private consumeRequest(request: OfflineAuthorityRequest): AuthorityRequestRecord | null {
    const record = this.requests.get(request);
    this.requests.delete(request);
    return record?.continuityEpoch === this.continuityEpoch ? record : null;
  }

  private matchesGrantAudience(payload: OfflineGrantPayload): boolean {
    return (
      payload.org_id === this.options.orgId &&
      payload.store_id === this.options.storeId &&
      payload.staff_id === this.options.staffId &&
      payload.device_id === this.options.deviceId
    );
  }

  private matchesLeaseAudience(payload: PrimaryLeasePayload): boolean {
    return payload.store_id === this.options.storeId && payload.device_id === this.options.deviceId;
  }

  private offlineModeFor(command: string): "grant" | "primary_lease" | null {
    try {
      const summary = validateOfflineGrantAllowedCommands([command], this.options.registrySnapshot);
      return summary.primary_lease_commands.length === 1 ? "primary_lease" : "grant";
    } catch {
      return null;
    }
  }

  private currentGrant(nowMs: number): ActiveGrant | null {
    return this.activeGrant !== null && nowMs < this.activeGrant.deadlineMonoMs
      ? this.activeGrant
      : null;
  }

  private authorizeGrant(
    envelope: EdgeQueueEnvelope,
    grant: ActiveGrant,
  ): OfflineAuthorizationResult {
    if (envelope.authorization.kind !== "grant") return failAuthorization("grant_mismatch");
    if (!grant.payload.allowed_commands.includes(envelope.payload.command)) {
      return failAuthorization("grant_mismatch");
    }
    return Object.freeze({
      ok: true,
      command: envelope.payload.command,
      mode: "grant",
      localDeadlineMonoMs: grant.deadlineMonoMs,
    });
  }

  private authorizePrimaryLease(
    envelope: EdgeQueueEnvelope,
    grant: ActiveGrant,
    nowMs: number,
  ): OfflineAuthorizationResult {
    if (envelope.authorization.kind !== "primary_lease") return failAuthorization("lease_required");
    if (!grant.payload.allowed_commands.includes(envelope.payload.command)) {
      return failAuthorization("grant_mismatch");
    }
    const lease = this.currentLease(nowMs);
    if (lease === null)
      return failAuthorization(this.activeLease ? "lease_expired" : "lease_required");
    if (!this.matchesEnvelopeLease(envelope, lease)) return failAuthorization("lease_mismatch");
    return this.authorizeLeaseSequence(envelope, lease);
  }

  private currentLease(nowMs: number): ActiveLease | null {
    return this.activeLease !== null && nowMs < this.activeLease.deadlineMonoMs
      ? this.activeLease
      : null;
  }

  private matchesEnvelopeLease(envelope: EdgeQueueEnvelope, lease: ActiveLease): boolean {
    if (envelope.authorization.kind !== "primary_lease") return false;
    return (
      envelope.authorization.lease_id === lease.payload.lease_id &&
      envelope.authorization.primary_epoch === lease.payload.primary_epoch
    );
  }

  private authorizeLeaseSequence(
    envelope: EdgeQueueEnvelope,
    lease: ActiveLease,
  ): OfflineAuthorizationResult {
    if (envelope.authorization.kind !== "primary_lease") return failAuthorization("lease_required");
    const key = primaryLeaseKey(lease.payload);
    const previous = this.leaseHighWater.get(key);
    const sequence = envelope.authorization.per_lease_seq;
    if (previous !== undefined && sequence <= previous)
      return failAuthorization("sequence_replayed");
    if (
      (previous === undefined && sequence !== 1) ||
      (previous !== undefined && sequence !== previous + 1)
    ) {
      return failAuthorization("sequence_out_of_order");
    }
    this.leaseHighWater.set(key, sequence);
    return Object.freeze({
      ok: true,
      command: envelope.payload.command,
      mode: "primary_lease",
      localDeadlineMonoMs: lease.deadlineMonoMs,
    });
  }
}
