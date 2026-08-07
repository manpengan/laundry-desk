/** Pure member-account lifecycle planning. All money is integer fen. */

export const MEMBER_ACCOUNT_STATUSES = Object.freeze(["active", "frozen", "closed"] as const);
export type MemberAccountStatus = (typeof MEMBER_ACCOUNT_STATUSES)[number];
export type MemberLifecycleAction = "freeze" | "unfreeze" | "close";

export type MemberLifecycleRejectReason =
  "invalid_transition" | "stale_status" | "stale_balance" | "invalid_balance";

export type MemberLifecyclePlan = Readonly<{
  previous_status: MemberAccountStatus;
  status: MemberAccountStatus;
  refunded_principal_cents: number;
  forfeited_bonus_cents: number;
}>;

export type MemberLifecycleOutcome =
  | Readonly<{ ok: true; plan: MemberLifecyclePlan }>
  | Readonly<{ ok: false; reason: MemberLifecycleRejectReason }>;

export type PlanMemberLifecycleInput = Readonly<{
  action: MemberLifecycleAction;
  current_status: MemberAccountStatus;
  principal_cents: number;
  bonus_cents: number;
  expected_status?: MemberAccountStatus;
  expected_principal_cents?: number;
  expected_bonus_cents?: number;
}>;

const reject = (reason: MemberLifecycleRejectReason): MemberLifecycleOutcome =>
  Object.freeze({ ok: false as const, reason });

const success = (
  previousStatus: MemberAccountStatus,
  status: MemberAccountStatus,
  refundedPrincipalCents = 0,
  forfeitedBonusCents = 0,
): MemberLifecycleOutcome =>
  Object.freeze({
    ok: true as const,
    plan: Object.freeze({
      previous_status: previousStatus,
      status,
      refunded_principal_cents: refundedPrincipalCents,
      forfeited_bonus_cents: forfeitedBonusCents,
    }),
  });

function validBalance(principalCents: number, bonusCents: number): boolean {
  return (
    Number.isSafeInteger(principalCents) &&
    Number.isSafeInteger(bonusCents) &&
    principalCents >= 0 &&
    bonusCents >= 0 &&
    Number.isSafeInteger(principalCents + bonusCents)
  );
}

/**
 * Plan one exact lifecycle transition.
 *
 * Close snapshots status and both balance components in its frozen R4 input.
 * The caller must still lock the account row and re-project the ledger before
 * invoking this function; a mismatch refuses instead of closing a value the
 * approvers did not see.
 */
export function planMemberLifecycle(input: PlanMemberLifecycleInput): MemberLifecycleOutcome {
  if (!validBalance(input.principal_cents, input.bonus_cents)) {
    return reject("invalid_balance");
  }

  if (input.action === "freeze") {
    return input.current_status === "active"
      ? success("active", "frozen")
      : reject("invalid_transition");
  }

  if (input.action === "unfreeze") {
    return input.current_status === "frozen"
      ? success("frozen", "active")
      : reject("invalid_transition");
  }

  if (input.current_status === "closed") return reject("invalid_transition");
  if (input.expected_status !== input.current_status) return reject("stale_status");
  if (
    input.expected_principal_cents !== input.principal_cents ||
    input.expected_bonus_cents !== input.bonus_cents
  ) {
    return reject("stale_balance");
  }

  return success(input.current_status, "closed", input.principal_cents, input.bonus_cents);
}
