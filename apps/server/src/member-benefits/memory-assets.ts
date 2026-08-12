import { addCalendarDays, isExpiredOn } from "./date.js";
import { activeCouponRedemption } from "./memory-coupons.js";
import { appendRecord, mapWith, type MemoryBenefitsContext } from "./memory-state.js";
import { rejectBenefit, requireActiveAccount } from "./memory-support.js";
import { benefitsFromState } from "./memory-view.js";
import type {
  AssetGrantStoreInput,
  BenefitMutationResult,
  CouponConsumeStoreInput,
  MemberBenefitOutcome,
  PunchConsumeStoreInput,
} from "./types.js";

export async function grantMemoryAsset(
  context: MemoryBenefitsContext,
  input: AssetGrantStoreInput,
): Promise<MemberBenefitOutcome<BenefitMutationResult>> {
  const account = await requireActiveAccount(context, input.account_id);
  if (!account.ok) return account;
  const state = context.read();
  const definition =
    input.asset_kind === "punch"
      ? state.punchTypes.get(input.definition_id)
      : state.couponTypes.get(input.definition_id);
  if (definition === undefined) return rejectBenefit("definition_not_found");
  if (definition.status === "retired") return rejectBenefit("definition_retired");
  const assetId = context.newId();

  const next =
    definition.kind === "punch_type"
      ? Object.freeze({
          ...state,
          punchCards: mapWith(
            state.punchCards,
            assetId,
            Object.freeze({
              asset_id: assetId,
              account_id: input.account_id,
              definition_id: definition.definition_id,
              code: definition.code,
              name: definition.name,
              total_uses: definition.total_uses,
              issued_on: input.business_date,
              expires_on: addCalendarDays(input.business_date, definition.valid_days),
            }),
          ),
        })
      : Object.freeze({
          ...state,
          couponGrants: mapWith(
            state.couponGrants,
            assetId,
            Object.freeze({
              asset_id: assetId,
              account_id: input.account_id,
              definition_id: definition.definition_id,
              code: definition.code,
              name: definition.name,
              discount_cents: definition.discount_cents,
              min_order_cents: definition.min_order_cents,
              granted_on: input.business_date,
              expires_on: addCalendarDays(input.business_date, definition.valid_days),
            }),
          ),
        });
  context.write(next);
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      benefits: benefitsFromState(next, account.value, input.business_date, true),
      entity_id: assetId,
      changed: true,
    }),
  });
}

export async function consumeMemoryPunch(
  context: MemoryBenefitsContext,
  input: PunchConsumeStoreInput,
): Promise<MemberBenefitOutcome<BenefitMutationResult>> {
  const state = context.read();
  const card = state.punchCards.get(input.asset_id);
  if (card === undefined) return rejectBenefit("asset_not_found");
  const account = await requireActiveAccount(context, card.account_id);
  if (!account.ok) return account;
  if (isExpiredOn(card.expires_on, input.business_date)) return rejectBenefit("asset_expired");
  const used = state.punchConsumes
    .filter((row) => row.asset_id === input.asset_id)
    .reduce((sum, row) => sum + row.uses, 0);
  if (used + input.uses > card.total_uses) return rejectBenefit("insufficient_uses");
  const row = Object.freeze({
    ledger_id: context.newId(),
    asset_id: input.asset_id,
    uses: input.uses,
    at: input.at,
    reason: input.reason,
  });
  const next = Object.freeze({
    ...state,
    punchConsumes: appendRecord(state.punchConsumes, row),
  });
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

export async function consumeMemoryCoupon(
  context: MemoryBenefitsContext,
  input: CouponConsumeStoreInput,
): Promise<MemberBenefitOutcome<BenefitMutationResult>> {
  const state = context.read();
  const grant = state.couponGrants.get(input.asset_id);
  if (grant === undefined) return rejectBenefit("asset_not_found");
  const account = await requireActiveAccount(context, grant.account_id);
  if (!account.ok) return account;
  if (isExpiredOn(grant.expires_on, input.business_date)) return rejectBenefit("asset_expired");
  if (activeCouponRedemption(state, input.asset_id) !== undefined) {
    return rejectBenefit("coupon_already_redeemed");
  }
  const order = await context.orderStore.getOrder(context.orgId, input.store_id, input.order_id);
  if (order === null) return rejectBenefit("order_not_found");
  if (order.customer_id !== account.value.customer_id) {
    return rejectBenefit("order_customer_mismatch");
  }
  if (order.discount_cents !== 0) return rejectBenefit("coupon_order_already_discounted");
  if (
    order.status !== "open" ||
    order.paid_cents !== 0 ||
    order.original_cents < grant.min_order_cents
  ) {
    return rejectBenefit("coupon_order_invalid");
  }
  if (context.orderStore.applyFixedCouponDiscount === undefined) {
    return rejectBenefit("coupon_order_invalid");
  }
  const discounted = await context.orderStore.applyFixedCouponDiscount({
    org_id: context.orgId,
    store_id: input.store_id,
    order_id: input.order_id,
    customer_id: account.value.customer_id,
    discount_cents: grant.discount_cents,
    min_order_cents: grant.min_order_cents,
    at: input.at,
  });
  if (discounted === null) return rejectBenefit("coupon_order_invalid");
  const redemption = Object.freeze({
    redemption_id: context.newId(),
    asset_id: grant.asset_id,
    account_id: grant.account_id,
    store_id: input.store_id,
    order_id: input.order_id,
    discount_cents: discounted.applied_discount_cents,
    at: input.at,
  });
  const next = Object.freeze({
    ...state,
    couponRedemptions: appendRecord(state.couponRedemptions, redemption),
  });
  context.write(next);
  return Object.freeze({
    ok: true as const,
    value: Object.freeze({
      benefits: benefitsFromState(next, account.value, input.business_date, true),
      entity_id: redemption.redemption_id,
      changed: true,
    }),
  });
}
