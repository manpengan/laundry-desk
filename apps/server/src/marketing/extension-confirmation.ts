import {
  MarketingGroupBuyRedemptionAuthoritySchema,
  MarketingGroupBuyRegistrationAuthoritySchema,
  MarketingGroupBuyVoucherRedeemInputSchema,
  MarketingGroupBuyVoucherRegisterInputSchema,
  MarketingReferralRewardAuthoritySchema,
  MarketingReferralRewardIssueInputSchema,
  createCommandError,
  type MarketingGroupBuyRedemptionAuthority,
  type MarketingGroupBuyRegistrationAuthority,
  type MarketingReferralRewardAuthority,
} from "@laundry/contracts";

import type { HandlerContext } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { PendingActionPreparer } from "../handlers/default-chain-hooks.js";
import { createSqlFeaturesStore } from "../platform/features.js";
import {
  groupBuyRedemptionSummary,
  groupBuyRegistrationSummary,
  referralRewardSummary,
} from "./extension-authority.js";
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

function client(context: Parameters<PendingActionPreparer>[1]) {
  if (context.transactionClient === undefined) fail("RESOURCE_UNAVAILABLE");
  return context.transactionClient;
}

function currentTime(deps: MarketingHandlerDeps): Date {
  const value = deps.now?.() ?? new Date();
  if (!Number.isFinite(value.getTime())) fail("INVARIANT_FAILED");
  return value;
}

async function authorize(
  deps: MarketingHandlerDeps,
  context: Parameters<PendingActionPreparer>[1],
): Promise<void> {
  if (context.actor.permissions?.includes("marketing_manage") !== true) fail("PERMISSION_DENIED");
  const sql = client(context);
  const features =
    deps.persistence === "sql" ? createSqlFeaturesStore(sql, context.tenant) : deps.features;
  if (!(await features.get(context.tenant.storeId)).marketing) fail("RESOURCE_UNAVAILABLE");
}

export function createMarketingExtensionConfirmationPreparer(
  deps: MarketingHandlerDeps,
): PendingActionPreparer {
  return async (parsed, context) => {
    const name = context.definition.name;
    if (
      name !== "marketing.referral.reward.issue" &&
      name !== "marketing.group_buy.voucher.register" &&
      name !== "marketing.group_buy.voucher.redeem"
    ) {
      return null;
    }
    await authorize(deps, context);
    const sql = client(context);
    const at = currentTime(deps);
    if (name === "marketing.referral.reward.issue") {
      const input = MarketingReferralRewardIssueInputSchema.parse(parsed);
      const preview = deps.store.previewReferralReward;
      if (preview === undefined) fail("RESOURCE_UNAVAILABLE");
      const resolved = await preview(sql, context.tenant, { ...input, at });
      if (!resolved.ok) reject(resolved.reason);
      return Object.freeze({
        authority: resolved.authority,
        summary: referralRewardSummary(resolved.authority),
      });
    }
    if (name === "marketing.group_buy.voucher.register") {
      const input = MarketingGroupBuyVoucherRegisterInputSchema.parse(parsed);
      const preview = deps.store.previewGroupBuyRegistration;
      if (preview === undefined) fail("RESOURCE_UNAVAILABLE");
      const resolved = await preview(sql, context.tenant, { ...input, at });
      if (!resolved.ok) reject(resolved.reason);
      return Object.freeze({
        authority: resolved.authority,
        summary: groupBuyRegistrationSummary(resolved.authority),
      });
    }
    const input = MarketingGroupBuyVoucherRedeemInputSchema.parse(parsed);
    const preview = deps.store.previewGroupBuyRedemption;
    if (preview === undefined) fail("RESOURCE_UNAVAILABLE");
    const resolved = await preview(sql, context.tenant, { ...input, at });
    if (!resolved.ok) reject(resolved.reason);
    return Object.freeze({
      authority: resolved.authority,
      summary: groupBuyRedemptionSummary(resolved.authority),
    });
  };
}

function confirmationPresent(context: HandlerContext): boolean {
  return context.request.confirmRef !== undefined;
}

export function requireFrozenReferralReward(
  context: HandlerContext,
  parsed: unknown,
): MarketingReferralRewardAuthority {
  const input = MarketingReferralRewardIssueInputSchema.parse(parsed);
  const frozen = MarketingReferralRewardAuthoritySchema.safeParse(context.confirmationAuthority);
  if (
    !confirmationPresent(context) ||
    !frozen.success ||
    frozen.data.campaign_id !== input.campaign_id ||
    frozen.data.campaign_version !== input.expected_version ||
    frozen.data.referrer_customer_id !== input.referrer_customer_id ||
    frozen.data.referred_customer_id !== input.referred_customer_id ||
    frozen.data.qualifying_order_id !== input.qualifying_order_id ||
    frozen.data.coupon_definition_id !== input.coupon_definition_id ||
    frozen.data.reason !== input.reason
  ) {
    fail("POLICY_DENIED");
  }
  return Object.freeze(frozen.data);
}

export function requireFrozenGroupBuyRegistration(
  context: HandlerContext,
  parsed: unknown,
): MarketingGroupBuyRegistrationAuthority {
  const input = MarketingGroupBuyVoucherRegisterInputSchema.parse(parsed);
  const frozen = MarketingGroupBuyRegistrationAuthoritySchema.safeParse(
    context.confirmationAuthority,
  );
  if (
    !confirmationPresent(context) ||
    !frozen.success ||
    frozen.data.code_digest !== input.voucher_code_digest ||
    frozen.data.code_last4 !== input.voucher_code_last4 ||
    frozen.data.provider !== input.provider ||
    frozen.data.external_order_ref !== input.external_order_ref ||
    frozen.data.label !== input.label ||
    frozen.data.face_value_cents !== input.face_value_cents ||
    frozen.data.expires_at !== input.expires_at ||
    frozen.data.reason !== input.reason
  ) {
    fail("POLICY_DENIED");
  }
  return Object.freeze(frozen.data);
}

export function requireFrozenGroupBuyRedemption(
  context: HandlerContext,
  parsed: unknown,
): MarketingGroupBuyRedemptionAuthority {
  const input = MarketingGroupBuyVoucherRedeemInputSchema.parse(parsed);
  const frozen = MarketingGroupBuyRedemptionAuthoritySchema.safeParse(
    context.confirmationAuthority,
  );
  if (
    !confirmationPresent(context) ||
    !frozen.success ||
    frozen.data.code_digest !== input.voucher_code_digest ||
    frozen.data.order_id !== input.order_id ||
    frozen.data.reason !== input.reason
  ) {
    fail("POLICY_DENIED");
  }
  return Object.freeze(frozen.data);
}
