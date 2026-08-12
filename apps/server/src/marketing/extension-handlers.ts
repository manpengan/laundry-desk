import {
  MarketingGroupBuyVoucherRedeemInputSchema,
  MarketingGroupBuyVoucherRedeemResultSchema,
  MarketingGroupBuyVoucherRegisterInputSchema,
  MarketingGroupBuyVoucherRegisterResultSchema,
  MarketingReferralRewardIssueInputSchema,
  MarketingReferralRewardIssueResultSchema,
  createCommandError,
} from "@laundry/contracts";

import type { CommandHandler, HandlerContext, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import { createSqlFeaturesStore } from "../platform/features.js";
import {
  requireFrozenGroupBuyRedemption,
  requireFrozenGroupBuyRegistration,
  requireFrozenReferralReward,
} from "./extension-confirmation.js";
import type { MarketingExtensionRejectReason } from "./extension-types.js";
import type { MarketingHandlerDeps } from "./types.js";

function fail(
  code:
    | "RESOURCE_UNAVAILABLE"
    | "PERMISSION_DENIED"
    | "VALIDATION_FAILED"
    | "INVARIANT_FAILED"
    | "IDEMPOTENCY_CONFLICT"
    | "POLICY_DENIED",
): never {
  throw new HandlerCommandError(createCommandError(code));
}

function reject(reason: MarketingExtensionRejectReason): never {
  if (
    reason === "missing" ||
    reason === "customer_invalid" ||
    reason === "account_invalid" ||
    reason === "order_invalid" ||
    reason === "coupon_missing"
  ) {
    fail("VALIDATION_FAILED");
  }
  if (
    reason === "stale" ||
    reason === "already_rewarded" ||
    reason === "voucher_conflict" ||
    reason === "voucher_redeemed"
  ) {
    fail("IDEMPOTENCY_CONFLICT");
  }
  fail(reason === "authority_drift" ? "POLICY_DENIED" : "INVARIANT_FAILED");
}

async function authorize(deps: MarketingHandlerDeps, context: HandlerContext): Promise<void> {
  if (context.actor.permissions?.includes("marketing_manage") !== true) fail("PERMISSION_DENIED");
  const features =
    deps.persistence === "sql"
      ? createSqlFeaturesStore(context.client, context.tenant)
      : deps.features;
  if (!(await features.get(context.tenant.storeId)).marketing) fail("RESOURCE_UNAVAILABLE");
}

function currentTime(deps: MarketingHandlerDeps): Date {
  const value = deps.now?.() ?? new Date();
  if (!Number.isFinite(value.getTime())) fail("INVARIANT_FAILED");
  return value;
}

function referralHandler(deps: MarketingHandlerDeps): CommandHandler {
  return async (context): Promise<HandlerOutcome> => {
    await authorize(deps, context);
    const operation = deps.store.issueReferralReward;
    if (operation === undefined) fail("RESOURCE_UNAVAILABLE");
    const input = MarketingReferralRewardIssueInputSchema.parse(context.parsed);
    const resolved = await operation(context.client, context.tenant, {
      ...input,
      at: currentTime(deps),
      frozenAuthority: requireFrozenReferralReward(context, input),
    });
    if (!resolved.ok) reject(resolved.reason);
    const result = MarketingReferralRewardIssueResultSchema.parse({ reward: resolved.reward });
    if (resolved.reward.replayed) return Object.freeze({ result });
    return Object.freeze({
      result,
      audit: Object.freeze({
        entity: "marketing_referral_reward",
        entityId: resolved.reward.reward_id,
        afterJson: JSON.stringify({
          campaign_id: resolved.reward.campaign_id,
          campaign_version: resolved.reward.campaign_version,
          qualifying_order_id: resolved.reward.qualifying_order_id,
          coupon_definition_id: resolved.reward.coupon_definition_id,
          coupon_grant_id: resolved.reward.coupon_grant_id,
          budget_committed_cents: resolved.reward.budget_committed_cents,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "marketing.referral_reward_issued",
          payload: Object.freeze({
            reward_id: resolved.reward.reward_id,
            campaign_id: resolved.reward.campaign_id,
            coupon_grant_id: resolved.reward.coupon_grant_id,
          }),
        }),
      ]),
    });
  };
}

function registrationHandler(deps: MarketingHandlerDeps): CommandHandler {
  return async (context): Promise<HandlerOutcome> => {
    await authorize(deps, context);
    const operation = deps.store.registerGroupBuyVoucher;
    if (operation === undefined) fail("RESOURCE_UNAVAILABLE");
    const input = MarketingGroupBuyVoucherRegisterInputSchema.parse(context.parsed);
    const resolved = await operation(context.client, context.tenant, {
      ...input,
      at: currentTime(deps),
      frozenAuthority: requireFrozenGroupBuyRegistration(context, input),
    });
    if (!resolved.ok) reject(resolved.reason);
    const result = MarketingGroupBuyVoucherRegisterResultSchema.parse({
      voucher: resolved.voucher,
    });
    if (resolved.voucher.replayed) return Object.freeze({ result });
    return Object.freeze({
      result,
      audit: Object.freeze({
        entity: "group_buy_voucher",
        entityId: resolved.voucher.voucher_id,
        afterJson: JSON.stringify({
          provider: resolved.voucher.provider,
          code_last4: resolved.voucher.code_last4,
          face_value_cents: resolved.voucher.face_value_cents,
          expires_at: resolved.voucher.expires_at,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "marketing.group_buy_voucher_registered",
          payload: Object.freeze({ voucher_id: resolved.voucher.voucher_id }),
        }),
      ]),
    });
  };
}

function redemptionHandler(deps: MarketingHandlerDeps): CommandHandler {
  return async (context): Promise<HandlerOutcome> => {
    await authorize(deps, context);
    const operation = deps.store.redeemGroupBuyVoucher;
    if (operation === undefined) fail("RESOURCE_UNAVAILABLE");
    const input = MarketingGroupBuyVoucherRedeemInputSchema.parse(context.parsed);
    const resolved = await operation(context.client, context.tenant, {
      ...input,
      at: currentTime(deps),
      frozenAuthority: requireFrozenGroupBuyRedemption(context, input),
    });
    if (!resolved.ok) reject(resolved.reason);
    const result = MarketingGroupBuyVoucherRedeemResultSchema.parse({
      redemption: resolved.redemption,
    });
    if (resolved.redemption.replayed) return Object.freeze({ result });
    return Object.freeze({
      result,
      audit: Object.freeze({
        entity: "group_buy_redemption",
        entityId: resolved.redemption.redemption_id,
        afterJson: JSON.stringify({
          voucher_id: resolved.redemption.voucher_id,
          order_id: resolved.redemption.order_id,
          applied_discount_cents: resolved.redemption.applied_discount_cents,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "marketing.group_buy_voucher_redeemed",
          payload: Object.freeze({
            voucher_id: resolved.redemption.voucher_id,
            order_id: resolved.redemption.order_id,
            redemption_id: resolved.redemption.redemption_id,
          }),
        }),
      ]),
    });
  };
}

export function createMarketingExtensionHandlers(
  deps: MarketingHandlerDeps,
): Readonly<Record<string, CommandHandler>> {
  return Object.freeze({
    "marketing.referral.reward.issue": referralHandler(deps),
    "marketing.group_buy.voucher.register": registrationHandler(deps),
    "marketing.group_buy.voucher.redeem": redemptionHandler(deps),
  });
}
