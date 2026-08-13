import { describe, expect, it } from "vitest";

import {
  MARKETING_EXTENSION_COMMANDS,
  MarketingGroupBuyRedemptionAuthoritySchema,
  MarketingGroupBuyVoucherCodeSchema,
  MarketingGroupBuyVoucherRedeemInputSchema,
  MarketingGroupBuyVoucherRegisterInputSchema,
  MarketingReferralRewardIssueInputSchema,
} from "../src/index.js";

const UUIDS = Object.freeze([
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
] as const);

describe("ADR-54 marketing extension contracts", () => {
  it("freezes three R4, online-only and non-AI marketing writes", () => {
    expect(MARKETING_EXTENSION_COMMANDS.map((definition) => definition.name)).toEqual([
      "marketing.referral.reward.issue",
      "marketing.group_buy.voucher.register",
      "marketing.group_buy.voucher.redeem",
    ]);
    for (const definition of MARKETING_EXTENSION_COMMANDS) {
      expect(definition).toMatchObject({ risk: "R4", offline_mode: "denied" });
    }
    expect(
      MARKETING_EXTENSION_COMMANDS.slice(1).every((item) => item.data_classification === "secret"),
    ).toBe(true);
    expect(
      MARKETING_EXTENSION_COMMANDS.slice(1)
        .flatMap((item) => item.input_redaction)
        .every((rule) => rule.strategy === "remove"),
    ).toBe(true);
  });

  it("rejects self-referrals, unknown keys and malformed voucher secrets", () => {
    const referral = {
      campaign_id: UUIDS[0],
      expected_version: 1,
      referrer_customer_id: UUIDS[1],
      referred_customer_id: UUIDS[1],
      qualifying_order_id: UUIDS[2],
      coupon_definition_id: UUIDS[3],
      reason: "首单推荐",
    };
    expect(MarketingReferralRewardIssueInputSchema.safeParse(referral).success).toBe(false);
    expect(
      MarketingReferralRewardIssueInputSchema.safeParse({
        ...referral,
        referred_customer_id: UUIDS[2],
        tenant_id: UUIDS[0],
      }).success,
    ).toBe(false);
    expect(MarketingGroupBuyVoucherCodeSchema.safeParse("TOO-SHORT").success).toBe(false);
    expect(
      MarketingGroupBuyVoucherRedeemInputSchema.safeParse({
        voucher_code_digest: "a".repeat(64),
        order_id: UUIDS[0],
        reason: "门店核销",
      }).success,
    ).toBe(true);
    expect(
      MarketingGroupBuyVoucherRegisterInputSchema.safeParse({
        provider: "meituan",
        external_order_ref: "mt-order-1",
        voucher_code_digest: "a".repeat(64),
        voucher_code_last4: "2345",
        label: "团购洗护券",
        face_value_cents: 5_000,
        expires_at: "2026-09-01T00:00:00.000Z",
        reason: "平台售出",
      }).success,
    ).toBe(true);
  });

  it("keeps the raw voucher code out of frozen redemption authority", () => {
    const parsed = MarketingGroupBuyRedemptionAuthoritySchema.parse({
      kind: "marketing_group_buy_redemption",
      voucher_id: UUIDS[0],
      code_digest: "a".repeat(64),
      code_last4: "2345",
      provider: "douyin",
      external_order_ref: "dy-order-1",
      label: "洗护套餐",
      face_value_cents: 2_000,
      expires_at: "2026-09-01T00:00:00.000Z",
      order_id: UUIDS[1],
      order_original_cents: 3_000,
      order_payable_before_cents: 3_000,
      applied_discount_cents: 2_000,
      reason: "前台核销",
    });
    expect(JSON.stringify(parsed)).not.toContain("ABCD2345EFGH6789JKLM2345");
  });
});
