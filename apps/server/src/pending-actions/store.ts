/**
 * In-memory pending-action store (C5 skeleton).
 * Provides create / get / atomicConsume for unit tests and bus dry-wiring.
 * Production will swap to Postgres with CAS UPDATE … WHERE status='pending'.
 */

import { freezeCanonical, hashCanonical } from "./canonical.js";
import {
  PENDING_ACTION_TTL_SECONDS,
  type ConsumeResult,
  type CreatePendingActionInput,
  type EntityVersion,
  type PendingAction,
  type PendingActionStore,
} from "./types.js";

const freezeEntityVersions = (versions: readonly EntityVersion[]): readonly EntityVersion[] =>
  Object.freeze(
    versions.map((entry) =>
      Object.freeze({
        entityType: entry.entityType,
        entityId: entry.entityId,
        version: entry.version,
      }),
    ),
  );

const freezeAction = (action: PendingAction): PendingAction => Object.freeze({ ...action });

/**
 * Process-local store. Not shared across workers — Postgres CAS is the durable form.
 */
export class MemoryPendingActionStore implements PendingActionStore {
  private readonly records = new Map<string, PendingAction>();

  create(input: CreatePendingActionInput): PendingAction {
    if (this.records.has(input.nonce)) {
      throw new Error(`Pending action nonce already exists: ${input.nonce}`);
    }

    const args = freezeCanonical(input.args);
    const argsHash = hashCanonical(args);
    const ttl = input.ttlSeconds ?? PENDING_ACTION_TTL_SECONDS;
    const action = freezeAction({
      nonce: input.nonce,
      command: input.command,
      commandVersion: input.commandVersion,
      args,
      argsHash,
      entityVersions: freezeEntityVersions(input.entityVersions),
      creatorStaffId: input.creatorStaffId,
      orgId: input.orgId,
      storeId: input.storeId,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.createdAt,
      expiresAt: input.createdAt + ttl,
      status: "pending",
      effectiveRisk: input.effectiveRisk,
      policyOutcome: input.policyOutcome,
      requiresOtherApprover: input.requiresOtherApprover,
      consumedByStaffId: null,
      consumedAt: null,
    });

    this.records.set(action.nonce, action);
    return action;
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
        this.records.set(nonce, freezeAction({ ...current, status: "expired" }));
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

    const consumed = freezeAction({
      ...current,
      status: "consumed",
      consumedByStaffId: approverStaffId,
      consumedAt: now,
    });
    this.records.set(nonce, consumed);
    return Object.freeze({ ok: true as const, action: consumed });
  }

  /** Test helper: number of stored cards. */
  size(): number {
    return this.records.size;
  }

  /** Test helper: wipe all cards. */
  clear(): void {
    this.records.clear();
  }
}
