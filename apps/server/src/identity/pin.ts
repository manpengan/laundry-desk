/**
 * C6 PIN challenge create / verify with max attempts and staff/device lockout.
 * Uses contracts createPinChallenge + planQuickSwitchAttempt pure planners.
 */

import {
  PIN_CHALLENGE_MAX_ATTEMPTS,
  PIN_CHALLENGE_TTL_SECONDS,
  createPinChallenge,
  planQuickSwitchAttempt,
} from "@laundry/contracts";

import { newUuid } from "./crypto-util.js";
import type { PinPort } from "./password.js";
import type { SessionServiceDeps } from "./session.js";
import { issueSession } from "./session.js";
import type {
  IdentityClock,
  PinChallengeRecord,
  PinChallengeRepository,
  PinLockoutRepository,
  SessionIssueResult,
  SessionRecord,
  StaffRepository,
  Uuid,
} from "./types.js";
import { IdentityError } from "./types.js";

/** Design §3.4: 15-minute lockout beyond single-challenge attempt counters. */
export const PIN_LOCKOUT_SECONDS = 15 * 60;

export type PinServiceDeps = Readonly<{
  challenges: PinChallengeRepository;
  lockouts: PinLockoutRepository;
  staff: StaffRepository;
  pinPort: PinPort;
  clock: IdentityClock;
  sessions: SessionServiceDeps;
}>;

export type CreatePinChallengeInput = Readonly<{
  purpose: "quick_switch";
  session: SessionRecord;
  target_staff_id: Uuid;
}>;

export type PinChallengeView = Readonly<{
  challenge_id: Uuid;
  purpose: "quick_switch" | "step_up";
  expires_at: number;
  max_attempts: typeof PIN_CHALLENGE_MAX_ATTEMPTS;
}>;

const toRecord = (challenge: ReturnType<typeof createPinChallenge>): PinChallengeRecord => {
  if (challenge.purpose === "quick_switch") {
    return Object.freeze({
      challenge_id: challenge.challenge_id,
      purpose: "quick_switch",
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
      target_staff_id: challenge.target_staff_id,
    });
  }
  return Object.freeze({
    challenge_id: challenge.challenge_id,
    purpose: "step_up",
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
};

const toPlannerChallenge = (record: PinChallengeRecord) => {
  if (record.purpose !== "quick_switch" || record.target_staff_id === undefined) {
    throw new IdentityError("PIN_CHALLENGE_INVALID", "Unsupported challenge purpose");
  }
  return {
    purpose: "quick_switch" as const,
    challenge_id: record.challenge_id,
    session_id: record.session_id,
    session_version: record.session_version,
    org_id: record.org_id,
    store_id: record.store_id,
    device_id: record.device_id,
    nonce: record.nonce,
    issued_at: record.issued_at,
    expires_at: record.expires_at,
    status: record.status,
    failed_attempts: record.failed_attempts,
    max_attempts: record.max_attempts as typeof PIN_CHALLENGE_MAX_ATTEMPTS,
    requester_staff_id: record.requester_staff_id,
    target_staff_id: record.target_staff_id,
  };
};

export const createQuickSwitchChallenge = async (
  deps: PinServiceDeps,
  input: CreatePinChallengeInput,
): Promise<PinChallengeView> => {
  if (input.session.status !== "active") {
    throw new IdentityError("SESSION_INVALID", "Session is not active");
  }

  const now = deps.clock.nowEpochSeconds();
  const lockout = await deps.lockouts.get(
    input.session.org_id,
    input.session.store_id,
    input.target_staff_id,
    input.session.device_id,
  );
  if (lockout !== null && lockout.locked_until > now) {
    throw new IdentityError("PIN_LOCKED", "PIN is locked out");
  }

  const challenge = createPinChallenge({
    purpose: "quick_switch",
    challenge_id: newUuid(),
    session_id: input.session.session_id,
    session_version: input.session.session_version,
    org_id: input.session.org_id,
    store_id: input.session.store_id,
    device_id: input.session.device_id,
    nonce: newUuid(),
    issued_at: now,
    requester_staff_id: input.session.staff_id,
    target_staff_id: input.target_staff_id,
  });

  await deps.challenges.insert(toRecord(challenge));

  return Object.freeze({
    challenge_id: challenge.challenge_id,
    purpose: challenge.purpose,
    expires_at: challenge.expires_at,
    max_attempts: PIN_CHALLENGE_MAX_ATTEMPTS,
  });
};

export type VerifyPinInput = Readonly<{
  challenge_id: Uuid;
  pin: string;
  /** Current session bound to the challenge (from AuthContext). */
  session: SessionRecord;
}>;

const recordFailure = async (
  deps: PinServiceDeps,
  record: PinChallengeRecord,
  targetStaffId: Uuid,
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
        staff_id: targetStaffId,
        device_id: record.device_id,
        locked_until: now + PIN_LOCKOUT_SECONDS,
        failed_attempts: nextFailed,
      }),
    );
  }
};

/**
 * Verify PIN against an open quick_switch challenge.
 * Success issues a replacement session (does not mutate staff_id in place).
 */
export const verifyQuickSwitchPin = async (
  deps: PinServiceDeps,
  input: VerifyPinInput,
): Promise<SessionIssueResult> => {
  const now = deps.clock.nowEpochSeconds();
  const record = await deps.challenges.get(input.challenge_id);
  if (
    record === null ||
    record.purpose !== "quick_switch" ||
    record.target_staff_id === undefined
  ) {
    throw new IdentityError("PIN_CHALLENGE_INVALID", "Challenge not found");
  }

  const lockout = await deps.lockouts.get(
    record.org_id,
    record.store_id,
    record.target_staff_id,
    record.device_id,
  );
  if (lockout !== null && lockout.locked_until > now) {
    throw new IdentityError("PIN_LOCKED", "PIN is locked out");
  }

  const target = await deps.staff.findById(record.org_id, record.target_staff_id);
  if (target === null || !target.is_active || target.pin_hash === null) {
    throw new IdentityError("AUTHENTICATION_FAILED", "Authentication failed");
  }

  const pinOk = await deps.pinPort.verifyPassword(input.pin, target.pin_hash);
  const plannerChallenge = toPlannerChallenge(record);
  const currentBinding = {
    purpose: "quick_switch" as const,
    challenge_id: record.challenge_id,
    session_id: record.session_id,
    session_version: record.session_version,
    org_id: record.org_id,
    store_id: record.store_id,
    device_id: record.device_id,
    nonce: record.nonce,
    issued_at: record.issued_at,
    expires_at: record.expires_at,
    requester_staff_id: record.requester_staff_id,
    target_staff_id: record.target_staff_id,
  };

  const nextSessionId = newUuid();
  const nextFamilyId = newUuid();
  const plan = planQuickSwitchAttempt({
    challenge: plannerChallenge,
    current_binding: currentBinding,
    now_epoch_seconds: now,
    pin_verification: pinOk
      ? { valid: true, verified_staff_id: target.staff_id }
      : { valid: false },
    previous_session_id: input.session.session_id,
    previous_family_id: input.session.family_id,
    next_session_id: nextSessionId,
    next_family_id: nextFamilyId,
  });

  if (plan.kind === "reject") {
    throw new IdentityError("PIN_CHALLENGE_INVALID", plan.reason);
  }

  if (plan.kind === "record_failure") {
    await recordFailure(deps, record, record.target_staff_id);
    throw new IdentityError("AUTHENTICATION_FAILED", "Authentication failed");
  }

  // success
  const cas = await deps.challenges.casUpdate(record.challenge_id, record.failed_attempts, {
    failed_attempts: record.failed_attempts,
    status: "consumed",
  });
  if (cas !== 1) {
    throw new IdentityError("PIN_CHALLENGE_INVALID", "Challenge already consumed");
  }

  await deps.lockouts.clear(
    record.org_id,
    record.store_id,
    record.target_staff_id,
    record.device_id,
  );

  return issueSession(deps.sessions, {
    org_id: record.org_id,
    store_id: record.store_id,
    staff_id: target.staff_id,
    device_id: record.device_id,
    permission_version: target.permission_version,
    authentication_method: "pin",
    previous: {
      session_id: input.session.session_id,
      family_id: input.session.family_id,
      session_version: input.session.session_version,
    },
  });
};

export const createPinService = (deps: PinServiceDeps) =>
  Object.freeze({
    createQuickSwitchChallenge: (input: CreatePinChallengeInput) =>
      createQuickSwitchChallenge(deps, input),
    verifyQuickSwitchPin: (input: VerifyPinInput) => verifyQuickSwitchPin(deps, input),
    lockoutSeconds: PIN_LOCKOUT_SECONDS,
    maxAttempts: PIN_CHALLENGE_MAX_ATTEMPTS,
    challengeTtlSeconds: PIN_CHALLENGE_TTL_SECONDS,
  });
