import {
  MarketingCouponIssueConfirmationSummarySchema,
  MarketingCouponReversalConfirmationSummarySchema,
  type MarketingCouponIssueConfirmationSummary,
  type MarketingCouponIssueInput,
  type MarketingCouponIssuePreview,
  type MarketingCouponReversalConfirmationSummary,
} from "@laundry/contracts";

import type { MarketingCouponReversalPreview } from "./types.js";

export function couponIssueConfirmationSummary(
  input: MarketingCouponIssueInput,
  preview: MarketingCouponIssuePreview,
): MarketingCouponIssueConfirmationSummary {
  return Object.freeze(
    MarketingCouponIssueConfirmationSummarySchema.parse({
      kind: "marketing_coupon_issue",
      campaign_id: preview.campaign_id,
      campaign_version: preview.campaign_version,
      snapshot_id: preview.snapshot_id,
      audience_digest: preview.audience_digest,
      coupon_definition_id: preview.coupon_definition_id,
      coupon_version: preview.coupon_version,
      coupon_code: preview.coupon_code,
      coupon_name: preview.coupon_name,
      coupon_discount_cents: preview.coupon_discount_cents,
      coupon_min_order_cents: preview.coupon_min_order_cents,
      coupon_valid_days: preview.coupon_valid_days,
      audience_recipient_count: preview.audience_recipient_count,
      eligible_recipient_count: preview.eligible_recipient_count,
      ineligible_recipient_count: preview.ineligible_recipient_count,
      budget_required_cents: preview.budget_required_cents,
      budget_remaining_cents: preview.budget_remaining_cents,
      reason: input.reason,
    }),
  );
}

export function sameCouponIssueAuthority(
  input: MarketingCouponIssueInput,
  preview: MarketingCouponIssuePreview,
  frozen: MarketingCouponIssueConfirmationSummary,
): boolean {
  return JSON.stringify(couponIssueConfirmationSummary(input, preview)) === JSON.stringify(frozen);
}

export function couponReversalConfirmationSummary(
  input: Readonly<{ redemption_id: string; reason: string }>,
  preview: MarketingCouponReversalPreview,
): MarketingCouponReversalConfirmationSummary {
  return Object.freeze(
    MarketingCouponReversalConfirmationSummarySchema.parse({
      kind: "marketing_coupon_redemption_reversal",
      redemption_id: preview.redemptionId,
      grant_id: preview.grantId,
      order_id: preview.orderId,
      reversed_discount_cents: preview.discountCents,
      already_reversed: preview.alreadyReversed,
      reason: input.reason,
    }),
  );
}

export function sameCouponReversalAuthority(
  input: Readonly<{ redemptionId: string; reason: string }>,
  preview: MarketingCouponReversalPreview,
  frozen: MarketingCouponReversalConfirmationSummary,
): boolean {
  return (
    JSON.stringify(
      couponReversalConfirmationSummary(
        { redemption_id: input.redemptionId, reason: input.reason },
        preview,
      ),
    ) === JSON.stringify(frozen)
  );
}
