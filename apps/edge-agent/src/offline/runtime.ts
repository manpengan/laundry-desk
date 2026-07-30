import { createPublicKey, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  DesktopCommandExecuteInputSchema,
  DesktopCommandExecuteResultSchema,
  DesktopCommandNameSchema,
  DesktopOfflineResolveInputSchema,
  DesktopOfflineStatusResultSchema,
  M2_CONTRACT_DEFINITIONS,
  createCommandError,
  createOfflineGrantRegistrySnapshot,
  parseEdgeQueueEnvelope,
  type DesktopCommandExecuteResult,
  type DesktopOfflineResolveInput,
  type DesktopOfflineStatusResult,
  type DesktopSessionView,
  type EdgeAuthorityData,
  type EdgeQueueEnvelope,
} from "@laundry/contracts";

import type { DesktopHttpTransport } from "../desktop/http-transport.js";
import { OfflineAuthorizationGuard, type MonotonicClock } from "../lease/primary-lease.js";
import { DEFAULT_QUEUE_ENVELOPE_VERSION } from "../queue/types.js";
import type { PersistentEncryptedQueue } from "../queue/persistent-queue.js";
import { OfflineConflictStore } from "./conflict-store.js";

const OFFLINE_COMMANDS = new Set(["order.pickup", "payment.collect", "payment.repay"]);
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

type ActiveAuthority = Readonly<{
  guard: OfflineAuthorizationGuard;
  grantId: string;
  leaseId: string;
  primaryEpoch: number;
  nextSequence: number;
}>;

export type OfflineRuntimeOptions = Readonly<{
  queue: PersistentEncryptedQueue;
  conflicts: OfflineConflictStore;
  transport: Pick<DesktopHttpTransport, "edge">;
  clock?: MonotonicClock;
  now?: () => Date;
  randomId?: () => string;
}>;

function resourceFailure(): DesktopCommandExecuteResult {
  return Object.freeze({
    ok: false,
    error: createCommandError(
      "RESOURCE_UNAVAILABLE",
      Object.freeze({ kind: "reason", reason: "retry_later" }),
    ),
  });
}

function offlineSuccess(
  body: Readonly<Record<string, unknown>>,
  queueId: string,
): DesktopCommandExecuteResult {
  return DesktopCommandExecuteResultSchema.parse({
    ok: true,
    data: {
      execution: "executed",
      result: { ...body, offline_queued: true, queue_id: queueId },
    },
  });
}

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

export class OfflineCommandRuntime {
  private readonly queue: PersistentEncryptedQueue;
  private readonly conflicts: OfflineConflictStore;
  private readonly transport: Pick<DesktopHttpTransport, "edge">;
  private readonly clock: MonotonicClock;
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private authority: ActiveAuthority | null = null;
  private leaseIssuanceBlocked = false;

  constructor(options: OfflineRuntimeOptions) {
    this.queue = options.queue;
    this.conflicts = options.conflicts;
    this.transport = options.transport;
    this.clock = options.clock ?? createDefaultClock();
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? randomUUID;
  }

  provision(
    data: EdgeAuthorityData,
    session: DesktopSessionView,
    authorityRoundTripMs = 0,
  ): boolean {
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
      const grantRequest = guard.startAuthorityRequest();
      const leaseRequest = guard.startAuthorityRequest();
      if (!grantRequest.ok || !leaseRequest.ok) return false;
      const grant = guard.acceptOfflineGrant(data.offline_grant, grantRequest.request);
      const lease = guard.acceptPrimaryLease(data.primary_lease, leaseRequest.request);
      if (!grant.ok || !lease.ok) return false;
      this.authority = Object.freeze({
        guard,
        grantId: data.offline_grant.payload.grant_id,
        leaseId: data.primary_lease.payload.lease_id,
        primaryEpoch: data.primary_lease.payload.primary_epoch,
        nextSequence: 1,
      });
      return true;
    } catch {
      this.authority = null;
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
    const response = await this.transport.edge.authority();
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
    return this.provision(response.data, session, receivedAtMs - startedAtMs);
  }

  invalidateContinuity(): void {
    this.authority?.guard.invalidateContinuity();
    this.authority = null;
  }

  setLeaseIssuanceBlocked(blocked: boolean): void {
    this.leaseIssuanceBlocked = blocked;
    if (blocked) this.invalidateContinuity();
  }

  async queueCommand(input: unknown): Promise<DesktopCommandExecuteResult> {
    const parsed = await DesktopCommandExecuteInputSchema.safeParseAsync(input);
    if (!parsed.success || !("body" in parsed.data) || !OFFLINE_COMMANDS.has(parsed.data.name)) {
      return resourceFailure();
    }
    const authority = this.authority;
    const version = commandVersions.get(parsed.data.name);
    if (this.leaseIssuanceBlocked || authority === null || version === undefined) {
      return resourceFailure();
    }
    const queueId = this.randomId();
    const envelope = parseEdgeQueueEnvelope({
      queue_envelope_version: DEFAULT_QUEUE_ENVELOPE_VERSION,
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
      authorization: {
        kind: "primary_lease",
        grant_id: authority.grantId,
        lease_id: authority.leaseId,
        primary_epoch: authority.primaryEpoch,
        per_lease_seq: authority.nextSequence,
      },
    });
    const authorized = authority.guard.authorizeQueueEnvelope(envelope);
    if (!authorized.ok) return resourceFailure();
    try {
      this.queue.enqueue(envelope, queueId);
    } catch {
      this.invalidateContinuity();
      return resourceFailure();
    }
    this.authority = Object.freeze({
      ...authority,
      nextSequence: authority.nextSequence + 1,
    });
    return offlineSuccess(parsed.data.body, queueId);
  }

  async replay(): Promise<void> {
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
