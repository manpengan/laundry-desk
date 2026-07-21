/**
 * C5 step-up proof ↔ pending-action binding (types + pure verify).
 *
 * Aligns with contracts A5 PIN step-up semantics (args_hash, pending_action_ref,
 * requester ≠ approver, TTL, single-use). IO (PIN check, CAS store) stays in C6.
 */

import type { EntityVersion, PendingAction } from "../pending-actions/types.js";

/** Default step-up proof lifetime — matches contracts STEP_UP_PROOF_TTL_SECONDS. */
export const STEP_UP_PROOF_TTL_SECONDS = 300;

export type StepUpProofStatus = "active" | "consumed";

/**
 * Server-side proof issued after a successful PIN challenge for a pending action.
 * `pendingActionRef` is the pending-action nonce (opaque confirm_ref).
 */
export type StepUpProof = Readonly<{
  proofId: string;
  status: StepUpProofStatus;
  pendingActionRef: string;
  argsHash: string;
  entityVersions: readonly EntityVersion[];
  idempotencyKey: string;
  requesterStaffId: string;
  approverStaffId: string;
  orgId: string;
  storeId: string;
  issuedAt: number;
  expiresAt: number;
}>;

export type StepUpVerifyRejectReason =
  | "PROOF_CONSUMED"
  | "PROOF_EXPIRED"
  | "PROOF_NOT_ACTIVE"
  | "PROOF_BINDING_MISMATCH"
  | "SELF_APPROVE_FORBIDDEN"
  | "PENDING_NOT_FOUND"
  | "PENDING_NOT_PENDING"
  | "PENDING_EXPIRED"
  | "ARGS_HASH_MISMATCH"
  | "ENTITY_VERSION_MISMATCH"
  | "REQUESTER_MISMATCH";

export type StepUpVerifyResult =
  Readonly<{ ok: true }> | Readonly<{ ok: false; reason: StepUpVerifyRejectReason }>;

const entityVersionsEqual = (
  left: readonly EntityVersion[],
  right: readonly EntityVersion[],
): boolean => {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      entry.entityType === other.entityType &&
      entry.entityId === other.entityId &&
      entry.version === other.version
    );
  });
};

const reject = (reason: StepUpVerifyRejectReason): StepUpVerifyResult =>
  Object.freeze({ ok: false as const, reason });

/**
 * Verify a step-up proof is still valid and bound to the frozen pending action.
 * Does not consume the proof or the pending card — callers run atomicConsume after.
 */
export function verifyStepUpProof(
  proof: StepUpProof,
  pending: PendingAction | null,
  nowEpochSeconds: number,
): StepUpVerifyResult {
  if (proof.status === "consumed") return reject("PROOF_CONSUMED");
  if (nowEpochSeconds < proof.issuedAt) return reject("PROOF_NOT_ACTIVE");
  if (nowEpochSeconds >= proof.expiresAt) return reject("PROOF_EXPIRED");

  if (proof.approverStaffId === proof.requesterStaffId) {
    return reject("SELF_APPROVE_FORBIDDEN");
  }

  if (pending === null) return reject("PENDING_NOT_FOUND");
  if (pending.status !== "pending") return reject("PENDING_NOT_PENDING");
  if (nowEpochSeconds >= pending.expiresAt) return reject("PENDING_EXPIRED");

  if (proof.pendingActionRef !== pending.nonce) return reject("PROOF_BINDING_MISMATCH");
  if (proof.argsHash !== pending.argsHash) return reject("ARGS_HASH_MISMATCH");
  if (proof.requesterStaffId !== pending.creatorStaffId) return reject("REQUESTER_MISMATCH");
  if (proof.orgId !== pending.orgId || proof.storeId !== pending.storeId) {
    return reject("PROOF_BINDING_MISMATCH");
  }
  if (proof.idempotencyKey !== pending.idempotencyKey) {
    return reject("PROOF_BINDING_MISMATCH");
  }
  if (!entityVersionsEqual(proof.entityVersions, pending.entityVersions)) {
    return reject("ENTITY_VERSION_MISMATCH");
  }

  return Object.freeze({ ok: true as const });
}

/** Build a frozen proof record (status active). Caller supplies UUIDs + timestamps. */
export function createStepUpProof(input: {
  readonly proofId: string;
  readonly pending: PendingAction;
  readonly approverStaffId: string;
  readonly issuedAt: number;
  readonly ttlSeconds?: number;
}): StepUpProof {
  const ttl = input.ttlSeconds ?? STEP_UP_PROOF_TTL_SECONDS;
  if (input.approverStaffId === input.pending.creatorStaffId) {
    throw new Error("Step-up proof cannot be issued to the action creator");
  }
  return Object.freeze({
    proofId: input.proofId,
    status: "active" as const,
    pendingActionRef: input.pending.nonce,
    argsHash: input.pending.argsHash,
    entityVersions: input.pending.entityVersions,
    idempotencyKey: input.pending.idempotencyKey,
    requesterStaffId: input.pending.creatorStaffId,
    approverStaffId: input.approverStaffId,
    orgId: input.pending.orgId,
    storeId: input.pending.storeId,
    issuedAt: input.issuedAt,
    expiresAt: input.issuedAt + ttl,
  });
}
