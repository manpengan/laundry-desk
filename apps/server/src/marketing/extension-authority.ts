import {
  MarketingGroupBuyRedemptionAuthoritySchema,
  MarketingGroupBuyRedemptionConfirmationSummarySchema,
  MarketingGroupBuyRegistrationAuthoritySchema,
  MarketingGroupBuyRegistrationConfirmationSummarySchema,
  MarketingReferralRewardAuthoritySchema,
  MarketingReferralRewardConfirmationSummarySchema,
  type MarketingGroupBuyRedemptionAuthority,
  type MarketingGroupBuyRegistrationAuthority,
  type MarketingReferralRewardAuthority,
} from "@laundry/contracts";

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function referralRewardSummary(authority: MarketingReferralRewardAuthority) {
  const parsed = MarketingReferralRewardAuthoritySchema.parse(authority);
  const summary = {
    kind: parsed.kind,
    campaign_id: parsed.campaign_id,
    campaign_version: parsed.campaign_version,
    referrer_customer_id: parsed.referrer_customer_id,
    referred_customer_id: parsed.referred_customer_id,
    qualifying_order_id: parsed.qualifying_order_id,
    coupon_definition_id: parsed.coupon_definition_id,
    coupon_version: parsed.coupon_version,
    coupon_code: parsed.coupon_code,
    coupon_name: parsed.coupon_name,
    coupon_discount_cents: parsed.coupon_discount_cents,
    coupon_min_order_cents: parsed.coupon_min_order_cents,
    coupon_valid_days: parsed.coupon_valid_days,
    budget_remaining_cents: parsed.budget_remaining_cents,
    reason: parsed.reason,
  };
  return Object.freeze(MarketingReferralRewardConfirmationSummarySchema.parse(summary));
}

export function sameReferralRewardAuthority(
  current: MarketingReferralRewardAuthority,
  frozen: MarketingReferralRewardAuthority,
): boolean {
  return same(
    MarketingReferralRewardAuthoritySchema.parse(current),
    MarketingReferralRewardAuthoritySchema.parse(frozen),
  );
}

export function groupBuyRegistrationSummary(authority: MarketingGroupBuyRegistrationAuthority) {
  const parsed = MarketingGroupBuyRegistrationAuthoritySchema.parse(authority);
  const summary = {
    kind: parsed.kind,
    code_last4: parsed.code_last4,
    provider: parsed.provider,
    external_order_ref: parsed.external_order_ref,
    label: parsed.label,
    face_value_cents: parsed.face_value_cents,
    expires_at: parsed.expires_at,
    reason: parsed.reason,
  };
  return Object.freeze(MarketingGroupBuyRegistrationConfirmationSummarySchema.parse(summary));
}

export function sameGroupBuyRegistrationAuthority(
  current: MarketingGroupBuyRegistrationAuthority,
  frozen: MarketingGroupBuyRegistrationAuthority,
): boolean {
  return same(
    MarketingGroupBuyRegistrationAuthoritySchema.parse(current),
    MarketingGroupBuyRegistrationAuthoritySchema.parse(frozen),
  );
}

export function groupBuyRedemptionSummary(authority: MarketingGroupBuyRedemptionAuthority) {
  const parsed = MarketingGroupBuyRedemptionAuthoritySchema.parse(authority);
  const summary = {
    kind: parsed.kind,
    voucher_id: parsed.voucher_id,
    code_last4: parsed.code_last4,
    provider: parsed.provider,
    external_order_ref: parsed.external_order_ref,
    label: parsed.label,
    face_value_cents: parsed.face_value_cents,
    expires_at: parsed.expires_at,
    order_id: parsed.order_id,
    order_original_cents: parsed.order_original_cents,
    order_payable_before_cents: parsed.order_payable_before_cents,
    applied_discount_cents: parsed.applied_discount_cents,
    reason: parsed.reason,
  };
  return Object.freeze(MarketingGroupBuyRedemptionConfirmationSummarySchema.parse(summary));
}

export function sameGroupBuyRedemptionAuthority(
  current: MarketingGroupBuyRedemptionAuthority,
  frozen: MarketingGroupBuyRedemptionAuthority,
): boolean {
  return same(
    MarketingGroupBuyRedemptionAuthoritySchema.parse(current),
    MarketingGroupBuyRedemptionAuthoritySchema.parse(frozen),
  );
}
