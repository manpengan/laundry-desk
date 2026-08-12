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
