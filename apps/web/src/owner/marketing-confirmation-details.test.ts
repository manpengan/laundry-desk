import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import type {
  MarketingCouponIssueConfirmationSummary,
  MarketingGroupBuyRedemptionConfirmationSummary,
  MarketingGroupBuyRegistrationConfirmationSummary,
  MarketingReferralRewardConfirmationSummary,
} from "@laundry/contracts";

import { MarketingCouponIssueConfirmationDetails } from "./MarketingCouponConfirmationDetails.js";
import {
  MarketingGroupBuyRedemptionDetails,
  MarketingGroupBuyRegistrationDetails,
  MarketingReferralConfirmationDetails,
} from "./MarketingExtensionConfirmationDetails.js";

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

function assertVisible(html: string, values: readonly string[]): void {
  for (const value of values)
    assert.ok(html.includes(value), `missing confirmation value: ${value}`);
}

function assertNoSecretProjection(html: string): void {
  assert.doesNotMatch(html, /referrer-account-secret|referred-account-secret/u);
  assert.doesNotMatch(html, /0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/u);
  assert.doesNotMatch(html, /RAW-GROUP-BUY-CODE-2345/u);
}

test("the referral card renders every public frozen field without internal accounts", () => {
  const summary: MarketingReferralRewardConfirmationSummary = Object.freeze({
    kind: "marketing_referral_reward",
    campaign_id: "41111111-1111-4111-8111-111111111111",
    campaign_version: 3,
    referrer_customer_id: "42222222-2222-4222-8222-222222222222",
    referred_customer_id: "43333333-3333-4333-8333-333333333333",
    qualifying_order_id: "44444444-4444-4444-8444-444444444444",
    coupon_definition_id: "45555555-5555-4555-8555-555555555555",
    coupon_version: 7,
    coupon_code: "referral_5",
    coupon_name: "推荐五元券",
    coupon_discount_cents: 500,
    coupon_min_order_cents: 2_000,
    coupon_valid_days: 30,
    budget_remaining_cents: 4_500,
    reason: "首单推荐奖励",
  });
  const html = renderToStaticMarkup(
    createElement(MarketingReferralConfirmationDetails, { summary }),
  );

  assertVisible(html, [
    "发放推荐奖励",
    summary.campaign_id,
    "v3",
    summary.referrer_customer_id,
    summary.referred_customer_id,
    summary.qualifying_order_id,
    summary.coupon_definition_id,
    "v7",
    summary.coupon_code,
    summary.coupon_name,
    "¥5.00",
    "¥20.00",
    "30 天",
    "¥45.00",
    summary.reason,
  ]);
  assertNoSecretProjection(html);
});

test("the group-buy registration card renders every public field and no bearer material", () => {
  const summary: MarketingGroupBuyRegistrationConfirmationSummary = Object.freeze({
    kind: "marketing_group_buy_registration",
    code_last4: "2345",
    provider: "meituan",
    external_order_ref: "MT-ORDER-9001",
    label: "团购精洗券",
    face_value_cents: 3_000,
    expires_at: "2026-09-01T00:00:00.000Z",
    reason: "平台售出登记",
  });
  const html = renderToStaticMarkup(
    createElement(MarketingGroupBuyRegistrationDetails, { summary }),
  );

  assertVisible(html, [
    "登记团购券",
    summary.code_last4,
    summary.provider,
    summary.external_order_ref,
    summary.label,
    "¥30.00",
    summary.expires_at,
    summary.reason,
  ]);
  assertNoSecretProjection(html);
});

test("the group-buy redemption card renders voucher and full order money authority", () => {
  const summary: MarketingGroupBuyRedemptionConfirmationSummary = Object.freeze({
    kind: "marketing_group_buy_redemption",
    voucher_id: "46666666-6666-4666-8666-666666666666",
    code_last4: "2345",
    provider: "douyin",
    external_order_ref: "DY-ORDER-9002",
    label: "团购护理券",
    face_value_cents: 3_000,
    expires_at: "2026-10-01T00:00:00.000Z",
    order_id: "47777777-7777-4777-8777-777777777777",
    order_original_cents: 8_000,
    order_payable_before_cents: 8_000,
    applied_discount_cents: 3_000,
    reason: "前台核验通过",
  });
  const html = renderToStaticMarkup(createElement(MarketingGroupBuyRedemptionDetails, { summary }));

  assertVisible(html, [
    "核销团购券",
    summary.voucher_id,
    summary.code_last4,
    summary.provider,
    summary.external_order_ref,
    summary.label,
    "¥30.00",
    summary.expires_at,
    summary.order_id,
    "¥80.00",
    "¥50.00",
    summary.reason,
  ]);
  assertNoSecretProjection(html);
});
