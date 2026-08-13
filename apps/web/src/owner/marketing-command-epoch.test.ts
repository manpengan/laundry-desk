import assert from "node:assert/strict";
import test from "node:test";

import type {
  MarketingCouponIssueConfirmationSummary,
  MarketingCouponReversalConfirmationSummary,
} from "@laundry/contracts";

import {
  createMarketingCommandEpoch,
  marketingCommandEpochMatches,
  marketingIssueAuthorityKey,
  marketingIssueSummaryMatches,
  marketingReversalAuthorityKey,
  marketingReversalSummaryMatches,
  type MarketingCouponPreviewAuthority,
} from "./marketing-coupon-preview.js";

type Deferred<T> = Readonly<{ promise: Promise<T>; resolve: (value: T) => void }>;

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  if (resolve === undefined) throw new Error("deferred resolver unavailable");
  return Object.freeze({ promise, resolve });
}

const issueAuthority: MarketingCouponPreviewAuthority = Object.freeze({
  campaign_id: "11111111-1111-4111-8111-111111111111",
  expected_version: 3,
  snapshot_id: "22222222-2222-4222-8222-222222222222",
  coupon_definition_id: "33333333-3333-4333-8333-333333333333",
});

const issueSummary: MarketingCouponIssueConfirmationSummary = Object.freeze({
  kind: "marketing_coupon_issue",
  campaign_id: issueAuthority.campaign_id,
  campaign_version: issueAuthority.expected_version,
  snapshot_id: issueAuthority.snapshot_id,
  audience_digest: "a".repeat(64),
  coupon_definition_id: issueAuthority.coupon_definition_id,
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

test("a deferred issue first-hop cannot install a card after campaign authority changes", async () => {
  const pending = deferred<MarketingCouponIssueConfirmationSummary>();
  let generation = 1;
  let currentKey = marketingIssueAuthorityKey(issueAuthority, issueSummary.reason);
  const request = createMarketingCommandEpoch(generation, currentKey);
  const accepted = pending.promise.then((summary) =>
    marketingCommandEpochMatches(request, generation, currentKey) &&
    marketingIssueSummaryMatches(summary, issueAuthority, issueSummary.reason)
      ? summary
      : null,
  );

  generation += 1;
  currentKey = marketingIssueAuthorityKey(
    Object.freeze({ ...issueAuthority, snapshot_id: "44444444-4444-4444-8444-444444444444" }),
    issueSummary.reason,
  );
  pending.resolve(issueSummary);
  assert.equal(await accepted, null);
});

test("a deferred reversal first-hop cannot install a card after redemption input changes", async () => {
  const summary: MarketingCouponReversalConfirmationSummary = Object.freeze({
    kind: "marketing_coupon_redemption_reversal",
    redemption_id: "55555555-5555-4555-8555-555555555555",
    grant_id: "66666666-6666-4666-8666-666666666666",
    order_id: "77777777-7777-4777-8777-777777777777",
    reversed_discount_cents: 500,
    already_reversed: false,
    reason: "误核销",
  });
  const pending = deferred<MarketingCouponReversalConfirmationSummary>();
  let generation = 4;
  let currentKey = marketingReversalAuthorityKey(summary.redemption_id, summary.reason);
  const request = createMarketingCommandEpoch(generation, currentKey);
  const accepted = pending.promise.then((value) =>
    marketingCommandEpochMatches(request, generation, currentKey) &&
    marketingReversalSummaryMatches(value, summary.redemption_id, summary.reason)
      ? value
      : null,
  );

  generation += 1;
  currentKey = marketingReversalAuthorityKey(
    "88888888-8888-4888-8888-888888888888",
    summary.reason,
  );
  pending.resolve(summary);
  assert.equal(await accepted, null);
});
