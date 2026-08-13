import { describe, expect, it } from "vitest";

import {
  MARKETING_COUPON_COMMANDS,
  MARKETING_COUPON_QUERIES,
  MarketingCouponIssueInputSchema,
  MarketingCouponIssueConfirmationSummarySchema,
  MarketingCouponIssuePreviewResultSchema,
  MarketingCouponRedemptionReverseInputSchema,
  MarketingCouponReversalConfirmationSummarySchema,
} from "../src/index.js";

const CAMPAIGN = "11111111-1111-4111-8111-111111111111";
const SNAPSHOT = "22222222-2222-4222-8222-222222222222";
const COUPON = "33333333-3333-4333-8333-333333333333";

describe("ADR-53 campaign coupon contracts", () => {
  it("accepts only server-authority references and a bounded reason", () => {
    const input = {
      campaign_id: CAMPAIGN,
      expected_version: 3,
      snapshot_id: SNAPSHOT,
      coupon_definition_id: COUPON,
      reason: "八月回访活动",
    };
    expect(MarketingCouponIssueInputSchema.parse(input)).toEqual(input);
    expect(
      MarketingCouponIssueInputSchema.safeParse({
        ...input,
        recipient_ids: [CAMPAIGN],
      }).success,
    ).toBe(false);
    expect(
      MarketingCouponIssueInputSchema.safeParse({ ...input, discount_cents: 99_999 }).success,
    ).toBe(false);
    expect(
      MarketingCouponIssueInputSchema.safeParse({ ...input, reason: "x".repeat(257) }).success,
    ).toBe(false);
  });

  it("keeps issuance and correction R4 while previews stay read-only", () => {
    expect(MARKETING_COUPON_COMMANDS.map((definition) => definition.name)).toEqual([
      "marketing.campaign.coupons.issue",
      "marketing.coupon.redemption.reverse",
    ]);
    expect(MARKETING_COUPON_COMMANDS.every((definition) => definition.risk === "R4")).toBe(true);
    expect(
      MARKETING_COUPON_COMMANDS.every((definition) =>
        definition.input_redaction.some((rule) => rule.path === "/reason"),
      ),
    ).toBe(true);
    expect(
      MARKETING_COUPON_COMMANDS.every((definition) => definition.offline_mode === "denied"),
    ).toBe(true);
    expect(MARKETING_COUPON_QUERIES.map((definition) => definition.name)).toEqual([
      "marketing.campaign.coupons.preview",
      "marketing.campaign.coupon_batch.get",
    ]);
    expect(MARKETING_COUPON_QUERIES.every((definition) => definition.risk === "R2")).toBe(true);
  });

  it("validates aggregate eligibility without exposing recipient identities", () => {
    const parsed = MarketingCouponIssuePreviewResultSchema.parse({
      preview: {
        campaign_id: CAMPAIGN,
        campaign_version: 3,
        snapshot_id: SNAPSHOT,
        audience_digest: "a".repeat(64),
        coupon_definition_id: COUPON,
        coupon_version: 7,
        coupon_code: "august_return",
        coupon_name: "八月回访券",
        coupon_discount_cents: 500,
        coupon_min_order_cents: 2_000,
        coupon_valid_days: 30,
        audience_recipient_count: 12,
        eligible_recipient_count: 10,
        ineligible_recipient_count: 2,
        budget_required_cents: 5_000,
        budget_remaining_cents: 8_000,
        evaluated_at: "2026-08-13T01:00:00.000Z",
      },
    });
    expect(JSON.stringify(parsed)).not.toMatch(/customer|account|recipient_ids/iu);
  });

  it("requires a concrete immutable redemption target for correction", () => {
    expect(
      MarketingCouponRedemptionReverseInputSchema.safeParse({
        redemption_id: CAMPAIGN,
        reason: "误核销",
      }).success,
    ).toBe(true);
    expect(
      MarketingCouponRedemptionReverseInputSchema.safeParse({
        order_id: CAMPAIGN,
        reason: "误核销",
      }).success,
    ).toBe(false);
  });

  it("validates the complete server-frozen R4 summaries", () => {
    const issue = {
      kind: "marketing_coupon_issue",
      campaign_id: CAMPAIGN,
      campaign_version: 3,
      snapshot_id: SNAPSHOT,
      audience_digest: "a".repeat(64),
      coupon_definition_id: COUPON,
      coupon_version: 7,
      coupon_code: "august_return",
      coupon_name: "八月回访券",
      coupon_discount_cents: 500,
      coupon_min_order_cents: 2_000,
      coupon_valid_days: 30,
      audience_recipient_count: 12,
      eligible_recipient_count: 10,
      ineligible_recipient_count: 2,
      budget_required_cents: 5_000,
      budget_remaining_cents: 8_000,
      reason: "八月回访活动",
    };
    expect(MarketingCouponIssueConfirmationSummarySchema.parse(issue)).toEqual(issue);
    expect(
      MarketingCouponIssueConfirmationSummarySchema.safeParse({
        ...issue,
        budget_required_cents: 4_999,
      }).success,
    ).toBe(false);
    expect(
      MarketingCouponReversalConfirmationSummarySchema.safeParse({
        kind: "marketing_coupon_redemption_reversal",
        redemption_id: CAMPAIGN,
        grant_id: SNAPSHOT,
        order_id: COUPON,
        reversed_discount_cents: 500,
        already_reversed: false,
        reason: "误核销",
      }).success,
    ).toBe(true);
  });
});
