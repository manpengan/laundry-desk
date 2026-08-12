/**
 * In-memory pending-action store (C5 skeleton).
 * Provides create / get / atomicConsume for unit tests and bus dry-wiring.
 * Production will swap to Postgres with CAS UPDATE … WHERE status='pending'.
 */

import { freezeCanonical, hashCanonical } from "./canonical.js";
import { registerMemoryRollback } from "../db/memory-unit-of-work.js";
import {
  PENDING_ACTION_TTL_SECONDS,
  type ConsumeResult,
  type CreatePendingActionInput,
  type EntityVersion,
  type PendingAction,
  type PendingActionReadContext,
  type PendingActionStore,
  type PendingActionTransactionContext,
  type PendingRiskReservation,
  type PendingRiskReservationRequest,
  PendingRiskCapacityExceededError,
} from "./types.js";

export const freezeEntityVersions = (
  versions: readonly EntityVersion[],
): readonly EntityVersion[] =>
  Object.freeze(
    versions.map((entry) =>
      Object.freeze({
        entityType: entry.entityType,
        entityId: entry.entityId,
        version: entry.version,
      }),
    ),
  );

export const freezePendingAction = (action: PendingAction): PendingAction =>
  Object.freeze({ ...action });

/** Build the one canonical snapshot used by both memory and PostgreSQL stores. */
export function createPendingActionSnapshot(input: CreatePendingActionInput): PendingAction {
  const args = freezeCanonical(input.args);
  const authority = input.authority === undefined ? undefined : freezeCanonical(input.authority);
  const argsHash = hashCanonical(
    authority === undefined ? args : Object.freeze({ args, authority }),
  );
  const ttl = input.ttlSeconds ?? PENDING_ACTION_TTL_SECONDS;
  return freezePendingAction({
    nonce: input.nonce,
    command: input.command,
    commandVersion: input.commandVersion,
    args,
    ...(authority === undefined ? {} : { authority }),
    argsHash,
    entityVersions: freezeEntityVersions(input.entityVersions),
    creatorStaffId: input.creatorStaffId,
    orgId: input.orgId,
    storeId: input.storeId,
    idempotencyKey: input.idempotencyKey,
    privacySubjectCustomerId: input.privacySubjectCustomerId ?? null,
    createdAt: input.createdAt,
    expiresAt: input.createdAt + ttl,
    status: "pending",
    effectiveRisk: input.effectiveRisk,
    policyOutcome: input.policyOutcome,
    requiresOtherApprover: input.requiresOtherApprover,
    consumedByStaffId: null,
    consumedAt: null,
  });
}

/**
 * Process-local store. Not shared across workers — Postgres CAS is the durable form.
 */
export class MemoryPendingActionStore implements PendingActionStore {
  private readonly records = new Map<string, PendingAction>();

  lockPrivacy(): void {
    // The process-local map has no independent row locks to order.
  }

  measureRiskReservation(
    request: PendingRiskReservationRequest,
    transaction?: PendingActionTransactionContext,
  ): PendingRiskReservation {
    const windowStart = request.nowEpochSeconds - request.windowSeconds;
    const scoped = [...this.records.values()].filter(
      (action) =>
        (transaction === undefined ||
          (action.orgId === transaction.tenant.orgId &&
            action.storeId === transaction.tenant.storeId)) &&
        action.command === request.command &&
        action.commandVersion === request.commandVersion,
    );
    const activeCount = scoped.filter(
      (action) => action.status === "pending" && action.expiresAt > request.nowEpochSeconds,
    ).length;
    const rollingCount = scoped.filter((action) => action.createdAt >= windowStart).length;
    if (activeCount >= request.activePendingLimit || rollingCount >= request.rollingPendingLimit) {
      throw new PendingRiskCapacityExceededError("Active notification pending limit reached");
    }
    const priorUnits = scoped
      .filter(
        (action) =>
          action.createdAt >= windowStart &&
          (action.status === "consumed" ||
            (action.status === "pending" && action.expiresAt > request.nowEpochSeconds)),
      )
      .reduce((total, action) => total + notificationUnits(action.args), 0);
    return freezeRiskReservation(request, windowStart, priorUnits);
  }

  create(input: CreatePendingActionInput): PendingAction {
    if (this.records.has(input.nonce)) {
      throw new Error(`Pending action nonce already exists: ${input.nonce}`);
    }

    const action = createPendingActionSnapshot(input);

    this.records.set(action.nonce, action);
    registerMemoryRollback(() => {
      if (this.records.get(action.nonce) === action) this.records.delete(action.nonce);
    });
    return action;
  }

  findByIdempotency(
    command: string,
    idempotencyKey: string,
    context?: PendingActionReadContext | PendingActionTransactionContext,
  ): PendingAction | null {
    return (
      [...this.records.values()].find(
        (action) =>
          action.command === command &&
          action.idempotencyKey === idempotencyKey &&
          (context === undefined ||
            (action.orgId === context.tenant.orgId && action.storeId === context.tenant.storeId)),
      ) ?? null
    );
  }

  get(nonce: string): PendingAction | null {
    return this.records.get(nonce) ?? null;
  }

  /**
   * Single-writer consume: read → validate → replace only while still pending.
   * A concurrent second call sees ALREADY_CONSUMED (or EXPIRED after lazy mark).
   */
  atomicConsume(
    nonce: string,
    approverStaffId: string,
    options: Readonly<{
      nowEpochSeconds?: number;
      expectedArgsHash?: string;
    }> = {},
  ): ConsumeResult {
    const current = this.records.get(nonce);
    if (current === undefined) {
      return Object.freeze({ ok: false as const, reason: "NOT_FOUND" as const });
    }

    const now = options.nowEpochSeconds ?? Math.floor(Date.now() / 1000);

    if (current.status === "consumed") {
      return Object.freeze({ ok: false as const, reason: "ALREADY_CONSUMED" as const });
    }
    if (current.status === "denied") {
      return Object.freeze({ ok: false as const, reason: "DENIED" as const });
    }
    if (current.status === "expired" || now >= current.expiresAt) {
      if (current.status === "pending") {
        const expired = freezePendingAction({ ...current, status: "expired" });
        this.records.set(nonce, expired);
        this.restoreOnRollback(nonce, current, expired);
      }
      return Object.freeze({ ok: false as const, reason: "EXPIRED" as const });
    }

    if (current.requiresOtherApprover && approverStaffId === current.creatorStaffId) {
      return Object.freeze({ ok: false as const, reason: "SELF_APPROVE_FORBIDDEN" as const });
    }

    if (options.expectedArgsHash !== undefined && options.expectedArgsHash !== current.argsHash) {
      return Object.freeze({ ok: false as const, reason: "ARGS_HASH_MISMATCH" as const });
    }

    // CAS: only transition if the map still holds the same pending reference.
    if (this.records.get(nonce) !== current || current.status !== "pending") {
      return Object.freeze({ ok: false as const, reason: "ALREADY_CONSUMED" as const });
    }

    const consumed = freezePendingAction({
      ...current,
      status: "consumed",
      consumedByStaffId: approverStaffId,
      consumedAt: now,
    });
    this.records.set(nonce, consumed);
    this.restoreOnRollback(nonce, current, consumed);
    return Object.freeze({ ok: true as const, action: consumed });
  }

  pruneExpired(nowEpochSeconds: number): number {
    const retentionCutoff = nowEpochSeconds - 30 * 24 * 60 * 60;
    const expiredNonces = [...this.records.values()]
      .filter((action) => action.expiresAt <= retentionCutoff)
      .map((action) => action.nonce);
    for (const nonce of expiredNonces) {
      const current = this.records.get(nonce);
      if (current === undefined) continue;
      this.records.delete(nonce);
      registerMemoryRollback(() => {
        if (!this.records.has(nonce)) this.records.set(nonce, current);
      });
    }
    return expiredNonces.length;
  }

  /** Test helper: number of stored cards. */
  size(): number {
    return this.records.size;
  }

  /** Test helper: wipe all cards. */
  clear(): void {
    const previous = new Map(this.records);
    this.records.clear();
    registerMemoryRollback(() => {
      if (this.records.size === 0) {
        for (const [nonce, action] of previous) this.records.set(nonce, action);
      }
    });
  }

  private restoreOnRollback(nonce: string, before: PendingAction, after: PendingAction): void {
    registerMemoryRollback(() => {
      if (this.records.get(nonce) === after) this.records.set(nonce, before);
    });
  }
}

function notificationUnits(args: unknown): number {
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error("Notification risk reservation args are invalid");
  }
  const orderIds = (args as Readonly<Record<string, unknown>>).order_ids;
  if (!Array.isArray(orderIds) || orderIds.length < 1 || orderIds.length > 50) {
    throw new Error("Notification risk reservation order ids are invalid");
  }
  return orderIds.length;
}

function freezeRiskReservation(
  request: PendingRiskReservationRequest,
  windowStart: number,
  priorUnits: number,
): PendingRiskReservation {
  const aggregateUnits = priorUnits + request.units;
  if (!Number.isSafeInteger(aggregateUnits) || aggregateUnits < request.units) {
    throw new Error("Notification risk reservation total is invalid");
  }
  return Object.freeze({
    kind: request.kind,
    units: request.units,
    prior_units: priorUnits,
    aggregate_units: aggregateUnits,
    threshold: request.threshold,
    window_started_at_epoch: windowStart,
  });
}
