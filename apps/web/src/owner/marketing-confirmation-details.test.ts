import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import type { MarketingCouponIssueConfirmationSummary } from "@laundry/contracts";

import { MarketingCouponIssueConfirmationDetails } from "./MarketingCouponConfirmationDetails.js";

test("the issue confirmation card displays campaign, snapshot and complete coupon authority", () => {
  const summary: MarketingCouponIssueConfirmationSummary = Object.freeze({
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
  });
  const html = renderToStaticMarkup(
    createElement(MarketingCouponIssueConfirmationDetails, { summary }),
  );

  assert.match(html, new RegExp(summary.campaign_id, "u"));
  assert.match(html, new RegExp(summary.snapshot_id, "u"));
  assert.match(html, /回访五元券/u);
  assert.match(html, /v7/u);
  assert.match(html, /最低消费：¥20\.00/u);
  assert.match(html, /有效期：30 天/u);
});
