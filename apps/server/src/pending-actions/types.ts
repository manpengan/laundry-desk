/**
 * C5 pending confirmation cards (ai_pending_actions skeleton).
 * WYSIWYS: canonical args frozen server-side; confirm submits nonce only (ADR-05 #6/#10).
 */

import type { RiskLevel } from "@laundry/domain";
import type { SqlClient, TenantContext } from "../db/types.js";
import type { PolicyOutcome } from "../policy/types.js";

/** Default card lifetime — architecture §9.5 / ADR-05 (5 minutes). */
export const PENDING_ACTION_TTL_SECONDS = 300;

export type PendingActionStatus = "pending" | "consumed" | "expired" | "denied";

/** Snapshot of an entity version frozen on the card (TOCTOU guard). */
export type EntityVersion = Readonly<{
  entityType: string;
  entityId: string;
  version: number;
}>;

/** Canonical JSON value tree (no undefined; frozen after create). */
export type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

/**
 * Server-side authorization object for confirm / step_up outcomes.
 * `nonce` is the confirm_ref clients submit; args never leave the server copy.
 */
export type PendingAction = Readonly<{
  nonce: string;
  command: string;
  commandVersion: string;
  /** Frozen canonical args — sole authority at execution. */
  args: CanonicalJson;
  /** Optional server-derived authority frozen with the card (never accepted from wire input). */
  authority?: CanonicalJson;
  /** SHA-256 hex of args plus optional authority (WYSIWYS args_hash). */
  argsHash: string;
  entityVersions: readonly EntityVersion[];
  creatorStaffId: string;
  orgId: string;
  storeId: string;
  idempotencyKey: string;
  /** Epoch seconds. */
  createdAt: number;
  /** Epoch seconds. */
  expiresAt: number;
  status: PendingActionStatus;
  effectiveRisk: RiskLevel;
  /** Outcome that created the card (`confirm` or `step_up`). */
  policyOutcome: Extract<PolicyOutcome, "confirm" | "step_up">;
  /** When true, atomicConsume rejects approver === creatorStaffId. */
  requiresOtherApprover: boolean;
  /** Filled after successful atomicConsume. */
  consumedByStaffId: string | null;
  consumedAt: number | null;
}>;

export type CreatePendingActionInput = Readonly<{
  nonce: string;
  command: string;
  commandVersion: string;
  /** Raw args; store freezes via canonical snapshot. */
  args: unknown;
  /** Server-derived authority; stored and hash-bound alongside args when present. */
  authority?: unknown;
  entityVersions: readonly EntityVersion[];
  creatorStaffId: string;
  orgId: string;
  storeId: string;
  idempotencyKey: string;
  createdAt: number;
  /** Override TTL; default PENDING_ACTION_TTL_SECONDS. */
  ttlSeconds?: number;
  effectiveRisk: RiskLevel;
  policyOutcome: Extract<PolicyOutcome, "confirm" | "step_up">;
  requiresOtherApprover: boolean;
}>;

export type ConsumeRejectReason =
  | "NOT_FOUND"
  | "ALREADY_CONSUMED"
  | "EXPIRED"
  | "DENIED"
  | "SELF_APPROVE_FORBIDDEN"
  | "ARGS_HASH_MISMATCH";

export type ConsumeSuccess = Readonly<{
  ok: true;
  action: PendingAction;
}>;

export type ConsumeFailure = Readonly<{
  ok: false;
  reason: ConsumeRejectReason;
}>;

export type ConsumeResult = ConsumeSuccess | ConsumeFailure;

export type PendingActionReadContext = Readonly<{
  tenant: TenantContext;
}>;

export type PendingActionTransactionContext = PendingActionReadContext &
  Readonly<{
    client: SqlClient;
  }>;

type MaybePromise<T> = T | Promise<T>;

export type PendingActionStore = Readonly<{
  create: (
    input: CreatePendingActionInput,
    transaction?: PendingActionTransactionContext,
  ) => MaybePromise<PendingAction>;
  get: (
    nonce: string,
    context?: PendingActionReadContext | PendingActionTransactionContext,
  ) => MaybePromise<PendingAction | null>;
  /**
   * Atomically transition pending → consumed once.
   * Concurrent second consume fails with ALREADY_CONSUMED.
   */
  atomicConsume: (
    nonce: string,
    approverStaffId: string,
    options?: Readonly<{
      nowEpochSeconds?: number;
      /** When set, must equal stored args_hash (WYSIWYS re-check). */
      expectedArgsHash?: string;
      /** PostgreSQL stores require the command's already-open transaction. */
      transaction?: PendingActionTransactionContext;
    }>,
  ) => MaybePromise<ConsumeResult>;
}>;
