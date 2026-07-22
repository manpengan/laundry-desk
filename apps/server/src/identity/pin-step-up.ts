/**
 * C6 step-up PIN challenge + verify (A5 purpose=step_up).
 *
 * Binds to a real pending action (args_hash / entity_versions / idempotency).
 * Success issues a short-lived single-use proof — does not switch the session actor.
 */

import {
  PIN_CHALLENGE_MAX_ATTEMPTS,
  PIN_CHALLENGE_TTL_SECONDS,
  createPinChallenge,
  planStepUpAttempt,
} from "@laundry/contracts";

import type { PendingActionStore } from "../pending-actions/types.js";
import { createStepUpProof, type StepUpProof } from "../policy/step-up.js";
import type { StepUpProofStore } from "../policy/step-up-proof-store.js";
import { newUuid } from "./crypto-util.js";
import type { PinServiceDeps, PinChallengeView } from "./pin.js";
import { PIN_LOCKOUT_SECONDS } from "./pin.js";
import type { PinChallengeRecord, SessionRecord, Uuid } from "./types.js";
import { IdentityError } from "./types.js";

export type PinStepUpDeps = PinServiceDeps &
  Readonly<{
    pending: PendingActionStore;
    proofs: StepUpProofStore;
  }>;

export type CreateStepUpChallengeInput = Readonly<{
  purpose: "step_up";
  session: SessionRecord;
  pending_action_ref: string;
  approver_staff_id: Uuid;
}>;

export type StepUpVerifyResult = Readonly<{
  step_up_proof_id: Uuid;
  expires_at: number;
}>;

const toEntityVersions = (
  versions: readonly Readonly<{ entityType: string; entityId: string; version: number }>[],
) =>
  versions.map((entry) =>
    Object.freeze({
      entity_type: entry.entityType,
      entity_id: entry.entityId,
      version: entry.version,
    }),
  );

const toRecord = (
  challenge: Extract<ReturnType<typeof createPinChallenge>, { purpose: "step_up" }>,
): PinChallengeRecord =>
  Object.freeze({
    challenge_id: challenge.challenge_id,
    purpose: "step_up" as const,
    session_id: challenge.session_id,
    session_version: challenge.session_version,
    org_id: challenge.org_id,
    store_id: challenge.store_id,
    device_id: challenge.device_id,
    nonce: challenge.nonce,
    issued_at: challenge.issued_at,
    expires_at: challenge.expires_at,
    status: challenge.status,
    failed_attempts: challenge.failed_attempts,
    max_attempts: challenge.max_attempts,
    requester_staff_id: challenge.requester_staff_id,
    pending_action_ref: challenge.pending_action_ref,
    args_hash: challenge.args_hash,
    entity_versions: challenge.entity_versions,
    idempotency_key: challenge.idempotency_key,
    approver_staff_id: challenge.approver_staff_id,
  });

const requireStepUpRecord = (record: PinChallengeRecord | null): PinChallengeRecord => {
  if (
    record === null ||
    record.purpose !== "step_up" ||
    record.pending_action_ref === undefined ||
    record.args_hash === undefined ||
    record.idempotency_key === undefined ||
    record.approver_staff_id === undefined
  ) {
    throw new IdentityError("PIN_CHALLENGE_INVALID", "Challenge not found");
  }
  return record;
};

const recordFailure = async (
  deps: PinStepUpDeps,
  record: PinChallengeRecord,
  approverStaffId: Uuid,
): Promise<void> => {
  const nextFailed = record.failed_attempts + 1;
  const exhausted = nextFailed >= PIN_CHALLENGE_MAX_ATTEMPTS;
  await deps.challenges.casUpdate(record.challenge_id, record.failed_attempts, {
    failed_attempts: nextFailed,
    status: exhausted ? "consumed" : "active",
  });
  if (exhausted) {
    const now = deps.clock.nowEpochSeconds();
    await deps.lockouts.upsert(
      Object.freeze({
        org_id: record.org_id,
        store_id: record.store_id,
        staff_id: approverStaffId,
        device_id: record.device_id,
        locked_until: now + PIN_LOCKOUT_SECONDS,
        failed_attempts: nextFailed,
      }),
    );
  }
};

/**
 * Issue a step-up PIN challenge bound to an open pending card (confirm_ref).
 * Only the card creator's active session may request the challenge.
 */
export const createStepUpChallenge = async (
  deps: PinStepUpDeps,
  input: CreateStepUpChallengeInput,
): Promise<PinChallengeView> => {
  if (input.session.status !== "active") {
    throw new IdentityError("SESSION_INVALID", "Session is not active");
  }

  const now = deps.clock.nowEpochSeconds();
  const pending = deps.pending.get(input.pending_action_ref);
  if (pending === null || pending.status !== "pending" || now >= pending.expiresAt) {
    throw new IdentityError("PIN_CHALLENGE_INVALID", "Pending action not available");
  }
  if (pending.orgId !== input.session.org_id || pending.storeId !== input.session.store_id) {
    throw new IdentityError("PIN_CHALLENGE_INVALID", "Pending action not available");
  }
  if (input.session.staff_id !== pending.creatorStaffId) {
    throw new IdentityError(
      "PIN_CHALLENGE_INVALID",
      "Only the creator session may request step-up",
    );
  }
  if (input.approver_staff_id === pending.creatorStaffId) {
    throw new IdentityError("PIN_CHALLENGE_INVALID", "Step-up requires another staff member");
  }

  const lockout = await deps.lockouts.get(
    input.session.org_id,
    input.session.store_id,
    input.approver_staff_id,
    input.session.device_id,
  );
  if (lockout !== null && lockout.locked_until > now) {
    throw new IdentityError("PIN_LOCKED", "PIN is locked out");
  }

  const approver = await deps.staff.findById(input.session.org_id, input.approver_staff_id);
  if (approver === null || !approver.is_active || approver.pin_hash === null) {
    throw new IdentityError("AUTHENTICATION_FAILED", "Authentication failed");
  }

  const challenge = createPinChallenge({
    purpose: "step_up",
    challenge_id: newUuid(),
    session_id: input.session.session_id,
    session_version: input.session.session_version,
    org_id: input.session.org_id,
    store_id: input.session.store_id,
    device_id: input.session.device_id,
    nonce: newUuid(),
    issued_at: now,
    pending_action_ref: pending.nonce,
    args_hash: pending.argsHash,
    entity_versions: toEntityVersions(pending.entityVersions),
    idempotency_key: pending.idempotencyKey,
    requester_staff_id: pending.creatorStaffId,
    approver_staff_id: input.approver_staff_id,
  });
  if (challenge.purpose !== "step_up") {
    throw new IdentityError("PIN_CHALLENGE_INVALID", "Challenge purpose mismatch");
  }

  await deps.challenges.insert(toRecord(challenge));

  return Object.freeze({
    challenge_id: challenge.challenge_id,
    purpose: challenge.purpose,
    expires_at: challenge.expires_at,
    max_attempts: PIN_CHALLENGE_MAX_ATTEMPTS,
  });
};

export type VerifyStepUpPinInput = Readonly<{
  challenge_id: Uuid;
  pin: string;
  session: SessionRecord;
}>;

/**
 * Verify approver PIN against an open step_up challenge.
 * Does not replace the session; returns a single-use proof for confirm_ref resume.
 */
export const verifyStepUpPin = async (
  deps: PinStepUpDeps,
  input: VerifyStepUpPinInput,
): Promise<StepUpVerifyResult> => {
  const now = deps.clock.nowEpochSeconds();
  const record = requireStepUpRecord(await deps.challenges.get(input.challenge_id));
  const approverStaffId = record.approver_staff_id!;

  if (
    input.session.session_id !== record.session_id ||
    input.session.session_version !== record.session_version
  ) {
    throw new IdentityError("PIN_CHALLENGE_INVALID", "Challenge binding mismatch");
  }

  const lockout = await deps.lockouts.get(
    record.org_id,
    record.store_id,
    approverStaffId,
    record.device_id,
  );
  if (lockout !== null && lockout.locked_until > now) {
    throw new IdentityError("PIN_LOCKED", "PIN is locked out");
  }

  const pending = deps.pending.get(record.pending_action_ref!);
  if (pending === null || pending.status !== "pending" || now >= pending.expiresAt) {
    throw new IdentityError("PIN_CHALLENGE_INVALID", "Pending action not available");
  }
  if (pending.argsHash !== record.args_hash) {
    throw new IdentityError("PIN_CHALLENGE_INVALID", "Pending action binding mismatch");
  }

  const approver = await deps.staff.findById(record.org_id, approverStaffId);
  if (approver === null || !approver.is_active || approver.pin_hash === null) {
    throw new IdentityError("AUTHENTICATION_FAILED", "Authentication failed");
  }

  const pinOk = await deps.pinPort.verifyPassword(input.pin, approver.pin_hash);
  const proofId = newUuid();
  const entityVersions = (record.entity_versions ?? []).map((entry) => ({ ...entry }));
  const stepUpBinding = Object.freeze({
    purpose: "step_up" as const,
    challenge_id: record.challenge_id,
    session_id: record.session_id,
    session_version: record.session_version,
    org_id: record.org_id,
    store_id: record.store_id,
    device_id: record.device_id,
    nonce: record.nonce,
    issued_at: record.issued_at,
    expires_at: record.expires_at,
    pending_action_ref: record.pending_action_ref!,
    args_hash: record.args_hash!,
    entity_versions: entityVersions,
    idempotency_key: record.idempotency_key!,
    requester_staff_id: record.requester_staff_id,
    approver_staff_id: approverStaffId,
  });
  const plannerChallenge = Object.freeze({
    ...stepUpBinding,
    status: record.status,
    failed_attempts: record.failed_attempts,
    max_attempts: record.max_attempts as typeof PIN_CHALLENGE_MAX_ATTEMPTS,
  });

  const plan = planStepUpAttempt({
    challenge: plannerChallenge,
    current_binding: stepUpBinding,
    now_epoch_seconds: now,
    pin_verification: pinOk
      ? { valid: true, verified_staff_id: approver.staff_id }
      : { valid: false },
    proof_id: proofId,
  });

  if (plan.kind === "reject") {
    throw new IdentityError("PIN_CHALLENGE_INVALID", plan.reason);
  }
  if (plan.kind === "record_failure") {
    await recordFailure(deps, record, approverStaffId);
    throw new IdentityError("AUTHENTICATION_FAILED", "Authentication failed");
  }

  const cas = await deps.challenges.casUpdate(record.challenge_id, record.failed_attempts, {
    failed_attempts: record.failed_attempts,
    status: "consumed",
  });
  if (cas !== 1) {
    throw new IdentityError("PIN_CHALLENGE_INVALID", "Challenge already consumed");
  }

  await deps.lockouts.clear(record.org_id, record.store_id, approverStaffId, record.device_id);

  const proof: StepUpProof = createStepUpProof({
    proofId,
    pending,
    approverStaffId,
    issuedAt: now,
  });
  deps.proofs.insert(proof);

  return Object.freeze({
    step_up_proof_id: proof.proofId,
    expires_at: proof.expiresAt,
  });
};

export const createPinStepUpService = (deps: PinStepUpDeps) =>
  Object.freeze({
    createStepUpChallenge: (input: CreateStepUpChallengeInput) =>
      createStepUpChallenge(deps, input),
    verifyStepUpPin: (input: VerifyStepUpPinInput) => verifyStepUpPin(deps, input),
    challengeTtlSeconds: PIN_CHALLENGE_TTL_SECONDS,
  });
