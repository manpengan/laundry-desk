import { addCalendarDays } from "./date.js";
import { appendRecord, type MemoryBenefitsContext } from "./memory-state.js";
import { rejectBenefit, requireActiveAccount } from "./memory-support.js";
import { availablePointCredits, benefitsFromState } from "./memory-view.js";
import type {
  BenefitMutationResult,
  MemberBenefitOutcome,
  PointsEarnStoreInput,
  PointsRedeemStoreInput,
} from "./types.js";

function earnedPoints(paidCents: number, unitCents: number, pointsPerUnit: number): number | null {
  const value = (BigInt(paidCents) / BigInt(unitCents)) * BigInt(pointsPerUnit);
  return value > 0n && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

export async function earnMemoryPoints(
  context: MemoryBenefitsContext,
  input: PointsEarnStoreInput,
): Promise<MemberBenefitOutcome<BenefitMutationResult>> {
  const account = await requireActiveAccount(context, input.account_id);
  if (!account.ok) return account;
  const state = context.read();
  const existing = state.pointsLedger.find(
    (row) => row.kind === "earn" && row.order_id === input.order_id,
  );
  if (existing !== undefined) {
    if (existing.account_id !== input.account_id) return rejectBenefit("order_customer_mismatch");
    return Object.freeze({
      ok: true as const,
      value: Object.freeze({
        benefits: benefitsFromState(state, account.value, input.business_date, true),
        entity_id: existing.ledger_id,
        changed: false,
      }),
    });
  }

  const order = await context.orderStore.getOrder(context.orgId, input.store_id, input.order_id);
  if (order === null) return rejectBenefit("order_not_found");
  if (order.customer_id !== account.value.customer_id) {
    return rejectBenefit("order_customer_mismatch");
  }
  if (order.status !== "closed" || order.balance_cents !== 0 || order.paid_cents <= 0) {
    return rejectBenefit("order_not_settled");
  }
  const policy = state.pointsPolicy;
  if (policy === null || policy.status !== "active") return rejectBenefit("points_policy_missing");
  const points = earnedPoints(order.paid_cents, policy.unit_cents, policy.points_per_unit);
  if (points === null) return rejectBenefit("points_zero");
  const row = Object.freeze({
    ledger_id: context.newId(),
    account_id: input.account_id,
    kind: "earn" as const,
    points_delta: points,
    order_id: input.order_id,
    expires_on: addCalendarDays(input.business_date, policy.valid_days),
    at: input.at,
    note: null,
  });
  const next = Object.freeze({ ...state, pointsLedger: appendRecord(state.pointsLedger, row) });
  context.write(next);
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      benefits: benefitsFromState(next, account.value, input.business_date, true),
      entity_id: row.ledger_id,
      changed: true,
    }),
  });
}

export async function redeemMemoryPoints(
  context: MemoryBenefitsContext,
  input: PointsRedeemStoreInput,
): Promise<MemberBenefitOutcome<BenefitMutationResult>> {
  const account = await requireActiveAccount(context, input.account_id);
  if (!account.ok) return account;
  const state = context.read();
  const credits = availablePointCredits(state, input.account_id, input.business_date);
  const available = credits.reduce((sum, credit) => sum + credit.remaining, 0);
  if (available < input.points) return rejectBenefit("insufficient_points");

  const redeemId = context.newId();
  let remaining = input.points;
  const allocations = [];
  for (const credit of credits) {
    if (remaining === 0) break;
    const points = Math.min(remaining, credit.remaining);
    allocations.push(
      Object.freeze({
        allocation_id: context.newId(),
        redeem_ledger_id: redeemId,
        earn_ledger_id: credit.ledger_id,
        points,
      }),
    );
    remaining -= points;
  }
  if (remaining !== 0) throw new Error("Point allocation did not consume the requested amount");

  const debit = Object.freeze({
    ledger_id: redeemId,
    account_id: input.account_id,
    kind: "redeem" as const,
    points_delta: -input.points,
    order_id: null,
    expires_on: null,
    at: input.at,
    note: input.reason,
  });
  const next = Object.freeze({
    ...state,
    pointsLedger: appendRecord(state.pointsLedger, debit),
    pointsAllocations: Object.freeze([...state.pointsAllocations, ...allocations]),
  });
  context.write(next);
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      benefits: benefitsFromState(next, account.value, input.business_date, true),
      entity_id: redeemId,
      changed: true,
    }),
  });
}
