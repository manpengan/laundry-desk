import { randomUUID } from "node:crypto";
import {
  DesktopCommandExecuteInputSchema,
  DesktopCommandNameSchema,
  CURRENT_EDGE_QUEUE_ENVELOPE_VERSION,
  M2_CONTRACT_DEFINITIONS,
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
import { createDefaultMonotonicClock } from "../lease/primary-lease.js";
import type { MonotonicClock } from "../lease/primary-lease.js";
import type { AuthorityTrustStore } from "../pairing/authority-trust.js";
import type { PersistentEncryptedQueue } from "../queue/persistent-queue.js";
import {
  authorityMatchesSession,
  authorityCanRebindSession,
  bindAuthoritySession,
  readAuthorityMatchesSession,
  type ReadAuthoritySessionBinding,
} from "./authority-session.js";
import { prepareOfflineAuthority, type ActiveAuthority } from "./authority-provision.js";
import { OfflineConflictStore } from "./conflict-store.js";
import type { GrantSequenceStore } from "./grant-sequence-store.js";
import { isGrantCommandBodyAllowed, offlineQueueModeForCommand } from "./offline-command-policy.js";
import {
  observeOfflineDiagnostic,
  offlineQueueRejected,
  offlineQueuedSuccess,
  offlineRuntimeStatus,
  resolveOfflineRuntime,
} from "./offline-results.js";
import type { OfflineAuthorityDiagnostic, OfflineDiagnosticObserver } from "./offline-results.js";
import type { VerifiedOfflineReadAuthority } from "./read-authority.js";

const RETRYABLE_REPLAY_CODES = new Set([
  "AUTHENTICATION_FAILED",
  "CSRF_REJECTED",
  "EVENT_DISPATCH_FAILED",
  "RATE_LIMITED",
  "RESOURCE_UNAVAILABLE",
  "TRANSACTION_FAILED",
]);
const MAX_REPLAY_BATCH = 20;

const commandVersions = new Map(
  M2_CONTRACT_DEFINITIONS.filter((definition) => definition.kind === "command").map(
    (definition) => [definition.name, definition.version] as const,
  ),
);

type OfflineEdge = Pick<DesktopHttpTransport["edge"], "authority" | "replay">;
type OfflineEdgeTransport = Readonly<{ edge: OfflineEdge }>;

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
  onDiagnostic?: OfflineDiagnosticObserver | undefined;
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
  private readonly onDiagnostic: OfflineDiagnosticObserver | undefined;
  private authority: ActiveAuthority | null = null;
  private readAuthority: ReadAuthoritySessionBinding | null = null;
  private leaseIssuanceBlocked = false;

  constructor(options: OfflineRuntimeOptions) {
    this.queue = options.queue;
    this.conflicts = options.conflicts;
    this.grantSequences = options.grantSequences;
    this.transport = options.transport;
    this.authorityTrust = options.authorityTrust;
    this.clock = options.clock ?? createDefaultMonotonicClock();
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? randomUUID;
    this.randomAuthorityNonce = options.randomAuthorityNonce ?? randomUUID;
    this.onDiagnostic = options.onDiagnostic;
  }

  provision(
    data: EdgeAuthorityData,
    session: DesktopSessionView,
    requestNonce: string,
    authorityRoundTripMs = 0,
  ): boolean {
    if (this.leaseIssuanceBlocked) {
      observeOfflineDiagnostic(this.onDiagnostic, "continuity_blocked");
      this.authority = null;
      this.readAuthority = null;
      return false;
    }
    const prepared = prepareOfflineAuthority(
      data,
      session,
      requestNonce,
      this.clock,
      this.authorityTrust,
      authorityRoundTripMs,
    );
    if (!prepared.ok) {
      observeOfflineDiagnostic(this.onDiagnostic, prepared.reason);
      return false;
    }
    this.readAuthority = prepared.data.readAuthority;
    this.authority = prepared.data.authority;
    observeOfflineDiagnostic(this.onDiagnostic, "authority_provision_ok");
    return true;
  }

  private async requestAuthority(
    session: DesktopSessionView,
    requestPrimary: boolean,
  ): Promise<boolean> {
    const startedAtMs = this.clock.nowMs();
    const requestNonce = this.randomAuthorityNonce();
    const response = await this.transport.edge.authority(requestNonce, requestPrimary);
    const receivedAtMs = this.clock.nowMs();
    if (
      !Number.isFinite(startedAtMs) ||
      !Number.isFinite(receivedAtMs) ||
      startedAtMs < 0 ||
      receivedAtMs < startedAtMs ||
      this.clock.continuity() !== "trusted"
    ) {
      this.invalidateContinuity("continuity_clock");
      return false;
    }
    if (!response.ok) {
      observeOfflineDiagnostic(this.onDiagnostic, "authority_response_fail");
      return false;
    }
    return this.provision(response.data, session, requestNonce, receivedAtMs - startedAtMs);
  }

  async refreshAuthority(session: DesktopSessionView): Promise<boolean> {
    if (this.leaseIssuanceBlocked) {
      observeOfflineDiagnostic(this.onDiagnostic, "continuity_blocked");
      return false;
    }
    const startedAtMs = this.clock.nowMs();
    if (!Number.isFinite(startedAtMs) || startedAtMs < 0 || this.clock.continuity() !== "trusted") {
      this.invalidateContinuity("continuity_clock");
      return false;
    }
    const current = this.authority;
    observeOfflineDiagnostic(
      this.onDiagnostic,
      current === null ? "authority_refresh_missing" : "authority_refresh_existing",
    );
    const currentGrantUsable =
      current !== null &&
      authorityMatchesSession(current.binding, session) &&
      startedAtMs < current.grantDeadlineMonoMs;
    const requestPrimary = session.role === "admin" && currentGrantUsable;
    if (
      currentGrantUsable &&
      current !== null &&
      (!requestPrimary ||
        (current.primary !== null && startedAtMs < current.primary.leaseDeadlineMonoMs))
    ) {
      observeOfflineDiagnostic(this.onDiagnostic, "authority_refresh_reused");
      return true;
    }
    if (!currentGrantUsable && current !== null) {
      this.invalidateContinuity("continuity_current_reject");
      this.readAuthority = null;
    }
    return this.requestAuthority(session, requestPrimary);
  }

  invalidateContinuity(source: OfflineAuthorityDiagnostic = "continuity_external"): void {
    observeOfflineDiagnostic(this.onDiagnostic, source);
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

  reconcileSession(session: DesktopSessionView | null): void {
    if (session === null) {
      this.invalidateContinuity("continuity_session");
      this.clearReadAuthority();
      return;
    }
    const nextBinding = bindAuthoritySession(session);
    if (this.authority !== null) {
      if (!authorityCanRebindSession(this.authority.binding, session)) {
        observeOfflineDiagnostic(this.onDiagnostic, "authority_session_reject");
        this.invalidateContinuity("continuity_session");
      } else if (!authorityMatchesSession(this.authority.binding, session)) {
        this.authority = Object.freeze({ ...this.authority, binding: nextBinding });
      }
    }
    if (this.readAuthority !== null) {
      if (!authorityCanRebindSession(this.readAuthority.session, session))
        this.clearReadAuthority();
      else if (!readAuthorityMatchesSession(this.readAuthority, session)) {
        this.readAuthority = Object.freeze({ ...this.readAuthority, session: nextBinding });
      }
    }
  }

  setLeaseIssuanceBlocked(blocked: boolean): void {
    this.leaseIssuanceBlocked = blocked;
    if (blocked) {
      this.invalidateContinuity("continuity_blocked");
      this.clearReadAuthority();
    }
  }

  async queueCommand(input: unknown): Promise<DesktopCommandExecuteResult> {
    const parsed = await DesktopCommandExecuteInputSchema.safeParseAsync(input);
    if (!parsed.success || !("body" in parsed.data)) {
      return offlineQueueRejected(this.onDiagnostic, "input_parse");
    }
    const mode = offlineQueueModeForCommand(parsed.data.name);
    if (mode === null || !isGrantCommandBodyAllowed(parsed.data.name, parsed.data.body)) {
      return offlineQueueRejected(this.onDiagnostic, "mode");
    }
    const authority = this.authority;
    const version = commandVersions.get(parsed.data.name);
    if (this.leaseIssuanceBlocked || authority === null || version === undefined) {
      return offlineQueueRejected(this.onDiagnostic, "authority");
    }
    const primary = mode === "primary_lease" ? authority.primary : null;
    if (mode === "primary_lease" && primary === null) {
      return offlineQueueRejected(this.onDiagnostic, "authority");
    }
    let grantSequence: number | null = null;
    let authorization: QueueAuthorization;
    if (mode === "grant") {
      try {
        grantSequence = this.grantSequences.reserve(authority.grantId);
      } catch {
        this.invalidateContinuity("continuity_sequence");
        return offlineQueueRejected(this.onDiagnostic, "sequence");
      }
      authorization = Object.freeze({
        kind: "grant",
        grant_id: authority.grantId,
        per_grant_seq: grantSequence,
      });
    } else {
      if (primary === null) return offlineQueueRejected(this.onDiagnostic, "authority");
      authorization = Object.freeze({
        kind: "primary_lease",
        grant_id: authority.grantId,
        lease_id: primary.leaseId,
        primary_epoch: primary.primaryEpoch,
        per_lease_seq: primary.nextSequence,
      });
    }
    const queueId = this.randomId();
    let envelope: EdgeQueueEnvelope;
    try {
      envelope = parseEdgeQueueEnvelope({
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
    } catch {
      if (grantSequence !== null) this.invalidateContinuity("continuity_guard");
      return offlineQueueRejected(this.onDiagnostic, "envelope_parse");
    }
    const authorized = authority.guard.authorizeQueueEnvelope(envelope);
    if (!authorized.ok) {
      if (grantSequence !== null) this.invalidateContinuity("continuity_guard");
      return offlineQueueRejected(this.onDiagnostic, "guard");
    }
    try {
      this.queue.enqueue(envelope, queueId);
    } catch {
      this.invalidateContinuity("continuity_queue");
      return offlineQueueRejected(this.onDiagnostic, "enqueue");
    }
    if (grantSequence !== null) {
      try {
        this.grantSequences.commit(authority.grantId, grantSequence);
      } catch {
        // Envelope is durable; fail this grant closed but return its queued success.
        this.invalidateContinuity("continuity_queue");
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
    return offlineRuntimeStatus(this.queue, this.conflicts);
  }

  resolve(input: DesktopOfflineResolveInput): DesktopOfflineStatusResult {
    return resolveOfflineRuntime(this.queue, this.conflicts, input);
  }
}
