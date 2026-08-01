import { createPublicKey, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  DesktopCommandExecuteInputSchema,
  DesktopCommandNameSchema,
  DesktopOfflineResolveInputSchema,
  DesktopOfflineStatusResultSchema,
  CURRENT_EDGE_QUEUE_ENVELOPE_VERSION,
  M2_CONTRACT_DEFINITIONS,
  createOfflineGrantRegistrySnapshot,
  parseEdgeQueueEnvelope,
  type DesktopCommandExecuteResult,
  type DesktopOfflineResolveInput,
  type DesktopOfflineStatusResult,
  type DesktopSessionView,
  type EdgeAuthorityData,
  type EdgeQueueEnvelope,
  type QueueAuthorization,
} from "@laundry/contracts";

import type { DesktopHttpTransport } from "../desktop/http-transport.js";
import { OfflineAuthorizationGuard, type MonotonicClock } from "../lease/primary-lease.js";
import type { AuthorityTrustStore } from "../pairing/authority-trust.js";
import type { PersistentEncryptedQueue } from "../queue/persistent-queue.js";
import {
  authorityMatchesSession,
  bindAuthoritySession,
  bindReadAuthoritySession,
  readAuthorityMatchesSession,
  type AuthoritySessionBinding,
  type ReadAuthoritySessionBinding,
} from "./authority-session.js";
import { OfflineConflictStore } from "./conflict-store.js";
import type { GrantSequenceStore } from "./grant-sequence-store.js";
import { isGrantCommandBodyAllowed, offlineQueueModeForCommand } from "./offline-command-policy.js";
import { offlineQueuedSuccess, offlineResourceFailure } from "./offline-results.js";
import type { VerifiedOfflineReadAuthority } from "./read-authority.js";

const RETRYABLE_REPLAY_CODES = new Set([
  "AUTHENTICATION_FAILED",
  "CSRF_REJECTED",
  "EVENT_DISPATCH_FAILED",
  "RATE_LIMITED",
  "RESOURCE_UNAVAILABLE",
  "TRANSACTION_FAILED",
]);
const SAFETY_MARGIN_MS = 30_000;
const MAX_REPLAY_BATCH = 20;

const commandVersions = new Map(
  M2_CONTRACT_DEFINITIONS.filter((definition) => definition.kind === "command").map(
    (definition) => [definition.name, definition.version] as const,
  ),
);

function createDefaultClock(): MonotonicClock {
  let continuity: "trusted" | "uncertain" = "trusted";
  return Object.freeze({
    nowMs: () => performance.now(),
    continuity: () => continuity,
    invalidate: () => {
      continuity = "uncertain";
    },
  });
}

type ActiveAuthority = Readonly<{
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

type OfflineEdgeTransport = Readonly<{
  edge: Pick<DesktopHttpTransport["edge"], "authority" | "replay">;
}>;

export type OfflineRuntimeOptions = Readonly<{
  queue: PersistentEncryptedQueue;
  conflicts: OfflineConflictStore;
  grantSequences: GrantSequenceStore;
  transport: OfflineEdgeTransport;
  authorityTrust: AuthorityTrustStore;
  clock?: MonotonicClock;
  now?: () => Date;
  randomId?: () => string;
  randomAuthorityNonce?: () => string;
}>;

export class OfflineCommandRuntime {
  private readonly queue: PersistentEncryptedQueue;
  private readonly conflicts: OfflineConflictStore;
  private readonly grantSequences: GrantSequenceStore;
  private readonly transport: OfflineEdgeTransport;
  private readonly authorityTrust: AuthorityTrustStore;
  private readonly clock: MonotonicClock;
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly randomAuthorityNonce: () => string;
  private authority: ActiveAuthority | null = null;
  private readAuthority: ReadAuthoritySessionBinding | null = null;
  private leaseIssuanceBlocked = false;

  constructor(options: OfflineRuntimeOptions) {
    this.queue = options.queue;
    this.conflicts = options.conflicts;
    this.grantSequences = options.grantSequences;
    this.transport = options.transport;
    this.authorityTrust = options.authorityTrust;
    this.clock = options.clock ?? createDefaultClock();
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? randomUUID;
    this.randomAuthorityNonce = options.randomAuthorityNonce ?? randomUUID;
  }

  provision(
    data: EdgeAuthorityData,
    session: DesktopSessionView,
    requestNonce: string,
    authorityRoundTripMs = 0,
  ): boolean {
    if (this.leaseIssuanceBlocked) {
      this.authority = null;
      this.readAuthority = null;
      return false;
    }
    try {
      if (!Number.isFinite(authorityRoundTripMs) || authorityRoundTripMs < 0) return false;
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
        clock: this.clock,
        safetyMarginMs: SAFETY_MARGIN_MS + authorityRoundTripMs,
      });
      const grantRequest = guard.startAuthorityRequest(requestNonce);
      if (!grantRequest.ok) return false;
      const grant = guard.acceptOfflineGrant(data.offline_grant, grantRequest.request);
      if (!grant.ok || !this.authorityTrust.accept(publicKey)) return false;
      this.authority = null;
      this.readAuthority = bindReadAuthoritySession(session, data);
      const baseAuthority = Object.freeze({
        guard,
        binding: bindAuthoritySession(session),
        grantId: data.offline_grant.payload.grant_id,
        grantDeadlineMonoMs: grant.localDeadlineMonoMs,
        primary: null,
      });
      if (data.primary_lease === null) {
        this.authority = baseAuthority;
        return true;
      }
      const leaseRequest = guard.startAuthorityRequest(requestNonce);
      if (!leaseRequest.ok) return false;
      const lease = guard.acceptPrimaryLease(data.primary_lease, leaseRequest.request);
      if (!lease.ok) return false;
      this.authority = Object.freeze({
        ...baseAuthority,
        primary: Object.freeze({
          leaseId: data.primary_lease.payload.lease_id,
          primaryEpoch: data.primary_lease.payload.primary_epoch,
          nextSequence: 1,
          leaseDeadlineMonoMs: lease.localDeadlineMonoMs,
        }),
      });
      return true;
    } catch {
      this.authority = null;
      this.readAuthority = null;
      return false;
    }
  }

  async refreshAuthority(session: DesktopSessionView): Promise<boolean> {
    if (this.leaseIssuanceBlocked) return false;
    const startedAtMs = this.clock.nowMs();
    if (!Number.isFinite(startedAtMs) || startedAtMs < 0 || this.clock.continuity() !== "trusted") {
      this.invalidateContinuity();
      return false;
    }
    const requestPrimary = session.role === "admin";
    if (
      this.authority !== null &&
      authorityMatchesSession(this.authority.binding, session) &&
      startedAtMs < this.authority.grantDeadlineMonoMs &&
      (!requestPrimary ||
        (this.authority.primary !== null &&
          startedAtMs < this.authority.primary.leaseDeadlineMonoMs))
    ) {
      return true;
    }
    if (this.authority !== null) {
      this.authority.guard.invalidateContinuity();
      this.readAuthority = null;
    }
    this.authority = null;
    const requestNonce = this.randomAuthorityNonce();
    const response = await this.transport.edge.authority(requestNonce, requestPrimary);
    const receivedAtMs = this.clock.nowMs();
    if (
      !Number.isFinite(receivedAtMs) ||
      receivedAtMs < startedAtMs ||
      this.clock.continuity() !== "trusted"
    ) {
      this.invalidateContinuity();
      return false;
    }
    if (!response.ok) {
      this.authority = null;
      return false;
    }
    return this.provision(response.data, session, requestNonce, receivedAtMs - startedAtMs);
  }

  invalidateContinuity(): void {
    this.authority?.guard.invalidateContinuity();
    this.authority = null;
  }

  exportReadAuthority(session: DesktopSessionView): VerifiedOfflineReadAuthority | null {
    const binding = this.readAuthority;
    if (binding === null || !readAuthorityMatchesSession(binding, session)) return null;
    return binding.authority;
  }

  clearReadAuthority(): void {
    this.readAuthority = null;
  }

  setLeaseIssuanceBlocked(blocked: boolean): void {
    this.leaseIssuanceBlocked = blocked;
    if (blocked) {
      this.invalidateContinuity();
      this.clearReadAuthority();
    }
  }

  async queueCommand(input: unknown): Promise<DesktopCommandExecuteResult> {
    const parsed = await DesktopCommandExecuteInputSchema.safeParseAsync(input);
    if (!parsed.success || !("body" in parsed.data)) {
      return offlineResourceFailure();
    }
    const mode = offlineQueueModeForCommand(parsed.data.name);
    if (mode === null || !isGrantCommandBodyAllowed(parsed.data.name, parsed.data.body)) {
      return offlineResourceFailure();
    }
    const authority = this.authority;
    const version = commandVersions.get(parsed.data.name);
    if (this.leaseIssuanceBlocked || authority === null || version === undefined) {
      return offlineResourceFailure();
    }
    const primary = mode === "primary_lease" ? authority.primary : null;
    if (mode === "primary_lease" && primary === null) return offlineResourceFailure();
    let grantSequence: number | null = null;
    let authorization: QueueAuthorization;
    if (mode === "grant") {
      try {
        grantSequence = this.grantSequences.reserve(authority.grantId);
      } catch {
        this.invalidateContinuity();
        return offlineResourceFailure();
      }
      authorization = Object.freeze({
        kind: "grant",
        grant_id: authority.grantId,
        per_grant_seq: grantSequence,
      });
    } else {
      if (primary === null) return offlineResourceFailure();
      authorization = Object.freeze({
        kind: "primary_lease",
        grant_id: authority.grantId,
        lease_id: primary.leaseId,
        primary_epoch: primary.primaryEpoch,
        per_lease_seq: primary.nextSequence,
      });
    }
    const queueId = this.randomId();
    const envelope = parseEdgeQueueEnvelope({
      queue_envelope_version: CURRENT_EDGE_QUEUE_ENVELOPE_VERSION,
      contracts_major: 0,
      queue_id: queueId,
      enqueued_at: this.now().toISOString(),
      payload: {
        command: parsed.data.name,
        version,
        idempotency_key: this.randomId(),
        dry_run: false,
        mode: "direct",
        args: parsed.data.body,
      },
      authorization,
    });
    const authorized = authority.guard.authorizeQueueEnvelope(envelope);
    if (!authorized.ok) {
      if (grantSequence !== null) this.invalidateContinuity();
      return offlineResourceFailure();
    }
    try {
      this.queue.enqueue(envelope, queueId);
    } catch {
      this.invalidateContinuity();
      return offlineResourceFailure();
    }
    if (grantSequence !== null) {
      try {
        this.grantSequences.commit(authority.grantId, grantSequence);
      } catch {
        // Envelope is durable; fail this grant closed but return its queued success.
        this.invalidateContinuity();
      }
    } else if (primary !== null) {
      this.authority = Object.freeze({
        ...authority,
        primary: Object.freeze({ ...primary, nextSequence: primary.nextSequence + 1 }),
      });
    }
    return offlineQueuedSuccess(parsed.data.body, queueId);
  }

  async replay(): Promise<void> {
    if (this.leaseIssuanceBlocked) return;
    for (let index = 0; index < MAX_REPLAY_BATCH; index += 1) {
      const item = this.queue.dequeue();
      if (item === null || this.conflicts.has(item.id)) return;
      const result = await this.transport.edge.replay(item.envelope);
      if (result.ok) {
        this.queue.ack(item.id);
        this.conflicts.remove(item.id);
        continue;
      }
      if (RETRYABLE_REPLAY_CODES.has(result.error.code)) return;
      this.conflicts.put(
        Object.freeze({
          queue_id: item.id,
          command: DesktopCommandNameSchema.parse(item.envelope.payload.command),
          error_code: result.error.code,
          created_at: this.now().toISOString(),
        }),
      );
      return;
    }
  }

  status(): DesktopOfflineStatusResult {
    const status = this.queue.status();
    return DesktopOfflineStatusResultSchema.parse({
      ok: true,
      data: {
        pending_count: status.pendingCount,
        inflight_count: status.inflightCount,
        conflicts: this.conflicts.list(),
      },
    });
  }

  resolve(input: DesktopOfflineResolveInput): DesktopOfflineStatusResult {
    const parsed = DesktopOfflineResolveInputSchema.parse(input);
    if (parsed.action === "discard") this.queue.ack(parsed.queue_id);
    this.conflicts.remove(parsed.queue_id);
    return this.status();
  }
}

export type OfflineReplayEnvelope = EdgeQueueEnvelope;
