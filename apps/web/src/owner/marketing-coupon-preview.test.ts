import assert from "node:assert/strict";
import test from "node:test";

import { marketingCouponPreviewMatches } from "./marketing-coupon-preview.js";

const preview = Object.freeze({
  campaign_id: "11111111-1111-4111-8111-111111111111",
  campaign_version: 2,
  snapshot_id: "22222222-2222-4222-8222-222222222222",
  audience_digest: "a".repeat(64),
  coupon_definition_id: "33333333-3333-4333-8333-333333333333",
  coupon_version: 7,
  coupon_code: "return_5",
  coupon_name: "回访五元券",
  coupon_discount_cents: 500,
  coupon_min_order_cents: 2_000,
  coupon_valid_days: 30,
  audience_recipient_count: 2,
  eligible_recipient_count: 1,
  ineligible_recipient_count: 1,
  budget_required_cents: 500,
  budget_remaining_cents: 9_500,
  evaluated_at: "2026-08-13T02:00:00.000Z",
});

test("an old coupon preview cannot authorize a changed select value", () => {
  assert.equal(
    marketingCouponPreviewMatches(preview, {
      campaign_id: preview.campaign_id,
      expected_version: preview.campaign_version,
      snapshot_id: preview.snapshot_id,
      coupon_definition_id: preview.coupon_definition_id,
    }),
    true,
  );
  assert.equal(
    marketingCouponPreviewMatches(preview, {
      campaign_id: preview.campaign_id,
      expected_version: preview.campaign_version,
      snapshot_id: "44444444-4444-4444-8444-444444444444",
      coupon_definition_id: preview.coupon_definition_id,
    }),
    false,
  );
  assert.equal(
    marketingCouponPreviewMatches(preview, {
      campaign_id: preview.campaign_id,
      expected_version: preview.campaign_version,
      snapshot_id: preview.snapshot_id,
      coupon_definition_id: "55555555-5555-4555-8555-555555555555",
    }),
    false,
  );
});
