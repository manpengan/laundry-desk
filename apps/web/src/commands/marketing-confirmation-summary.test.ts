import assert from "node:assert/strict";
import test from "node:test";

import { readConfirmationSummary } from "./confirmation-summary.js";

test("marketing confirmation summaries accept only complete server authority", () => {
  const issue = {
    kind: "marketing_coupon_issue",
    campaign_id: "11111111-1111-4111-8111-111111111111",
    campaign_version: 3,
    snapshot_id: "22222222-2222-4222-8222-222222222222",
    audience_digest: "a".repeat(64),
    coupon_definition_id: "33333333-3333-4333-8333-333333333333",
    coupon_version: 7,
    coupon_code: "return_5",
    coupon_name: "回访五元券",
    coupon_discount_cents: 500,
    coupon_min_order_cents: 2_000,
    coupon_valid_days: 30,
    audience_recipient_count: 4,
    eligible_recipient_count: 3,
    ineligible_recipient_count: 1,
    budget_required_cents: 1_500,
    budget_remaining_cents: 8_500,
    reason: "八月回访",
  };
  assert.deepEqual(readConfirmationSummary(issue), issue);

  const reversal = {
    kind: "marketing_coupon_redemption_reversal",
    redemption_id: "44444444-4444-4444-8444-444444444444",
    grant_id: "55555555-5555-4555-8555-555555555555",
    order_id: "66666666-6666-4666-8666-666666666666",
    reversed_discount_cents: 500,
    already_reversed: false,
    reason: "顾客误用",
  };
  assert.deepEqual(readConfirmationSummary(reversal), reversal);
  assert.equal(
    readConfirmationSummary({
      kind: "marketing_coupon_issue",
      campaign_id: issue.campaign_id,
      reason: issue.reason,
    }),
    null,
  );
});

test("Item 9 summaries parse without exposing internal accounts or voucher digests", () => {
  const referral = {
    kind: "marketing_referral_reward",
    campaign_id: "11111111-1111-4111-8111-111111111111",
    campaign_version: 1,
    referrer_customer_id: "22222222-2222-4222-8222-222222222222",
    referred_customer_id: "33333333-3333-4333-8333-333333333333",
    qualifying_order_id: "44444444-4444-4444-8444-444444444444",
    coupon_definition_id: "55555555-5555-4555-8555-555555555555",
    coupon_version: 2,
    coupon_code: "referral_5",
    coupon_name: "推荐五元券",
    coupon_discount_cents: 500,
    coupon_min_order_cents: 0,
    coupon_valid_days: 30,
    budget_remaining_cents: 4_500,
    reason: "首单推荐",
  };
  assert.deepEqual(readConfirmationSummary(referral), referral);

  const registration = {
    kind: "marketing_group_buy_registration",
    code_last4: "2345",
    provider: "meituan",
    external_order_ref: "mt-1",
    label: "团购洗护券",
    face_value_cents: 3_000,
    expires_at: "2026-09-01T00:00:00.000Z",
    reason: "平台售出",
  };
  assert.deepEqual(readConfirmationSummary(registration), registration);
  assert.equal(readConfirmationSummary({ ...registration, code_digest: "a".repeat(64) }), null);

  const redemption = {
    kind: "marketing_group_buy_redemption",
    voucher_id: "66666666-6666-4666-8666-666666666666",
    code_last4: "2345",
    provider: "meituan",
    external_order_ref: "mt-1",
    label: "团购洗护券",
    face_value_cents: 3_000,
    expires_at: "2026-09-01T00:00:00.000Z",
    order_id: "77777777-7777-4777-8777-777777777777",
    order_original_cents: 5_000,
    order_payable_before_cents: 5_000,
    applied_discount_cents: 3_000,
    reason: "前台核销",
  };
  assert.deepEqual(readConfirmationSummary(redemption), redemption);
  assert.doesNotMatch(JSON.stringify(redemption), /code_digest|account_id/u);
});
