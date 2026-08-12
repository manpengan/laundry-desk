import assert from "node:assert/strict";
import test from "node:test";

import {
  MarketingCouponIssuePreviewResultSchema,
  MarketingCouponIssueResultSchema,
  MarketingCouponRedemptionReverseResultSchema,
} from "@laundry/contracts";

import type { ActorContext, CommandHandler } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createMemoryFeaturesStore } from "../platform/features.js";
import { createMarketingHandlers } from "./handlers.js";
import {
  couponIssueConfirmationSummary,
  couponReversalConfirmationSummary,
} from "./coupon-authority.js";
import type { MarketingStore } from "./types.js";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CAMPAIGN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SNAPSHOT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const COUPON = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const BATCH = "11111111-1111-4111-8111-111111111111";
const REDEMPTION = "22222222-2222-4222-8222-222222222222";
const REVERSAL = "33333333-3333-4333-8333-333333333333";
const GRANT = "44444444-4444-4444-8444-444444444444";
const ORDER = "55555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-08-13T02:00:00.000Z");
const TENANT: TenantContext = Object.freeze({ orgId: ORG, storeId: STORE, staffId: STAFF });
const ACTOR: ActorContext = Object.freeze({
  staffId: STAFF,
  deviceId: null,
  via: "ui",
  permissions: Object.freeze(["marketing_manage"]),
});
const PREVIEW = Object.freeze({
  campaign_id: CAMPAIGN,
  campaign_version: 1,
  snapshot_id: SNAPSHOT,
  audience_digest: "a".repeat(64),
  coupon_definition_id: COUPON,
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
  budget_remaining_cents: 9_000,
  evaluated_at: NOW.toISOString(),
});
const BATCH_RESULT = Object.freeze({
  batch_id: BATCH,
  campaign_id: CAMPAIGN,
  campaign_version: 1,
  snapshot_id: SNAPSHOT,
  audience_digest: PREVIEW.audience_digest,
  coupon_definition_id: COUPON,
  coupon_code: PREVIEW.coupon_code,
  coupon_discount_cents: 500,
  audience_recipient_count: 2,
  eligible_recipient_count: 1,
  granted_count: 1,
  budget_committed_cents: 500,
  created_at: NOW.toISOString(),
  replayed: false,
});

function context(
  name: string,
  parsed: unknown,
  actor: ActorContext = ACTOR,
  confirmationAuthority?: Parameters<CommandHandler>[0]["confirmationAuthority"],
): Parameters<CommandHandler>[0] {
  return Object.freeze({
    client: new FakeSqlClient(),
    tenant: TENANT,
    actor,
    parsed,
    request: Object.freeze({
      name,
      version: "0.1.0",
      input: parsed,
      dryRun: false,
      ...(confirmationAuthority === undefined ? {} : { confirmRef: "confirmed-card" }),
    }),
    ...(confirmationAuthority === undefined ? {} : { confirmationAuthority }),
  });
}

function store(): MarketingStore {
  return Object.freeze({
    setCampaign: async () => Object.freeze({ ok: false, reason: "missing" }),
    listCampaigns: async () => Object.freeze([]),
    getCampaign: async () => null,
    previewAudience: async () => null,
    freezeAudience: async () => Object.freeze({ ok: false, reason: "missing" }),
    previewCouponIssue: async () => Object.freeze({ ok: true, preview: PREVIEW }),
    issueCoupons: async () => Object.freeze({ ok: true, batch: BATCH_RESULT }),
    getCouponBatch: async () => BATCH_RESULT,
    previewCouponRedemptionReversal: async () =>
      Object.freeze({
        ok: true,
        preview: Object.freeze({
          redemptionId: REDEMPTION,
          grantId: GRANT,
          orderId: ORDER,
          discountCents: 500,
          alreadyReversed: false,
        }),
      }),
    reverseCouponRedemption: async () =>
      Object.freeze({
        ok: true,
        reversal: Object.freeze({
          reversal_id: REVERSAL,
          redemption_id: REDEMPTION,
          grant_id: GRANT,
          order_id: ORDER,
          reversed_discount_cents: 500,
          changed: true,
          at: NOW.toISOString(),
        }),
      }),
  });
}

function handlers(marketing = true) {
  return createMarketingHandlers({
    store: store(),
    features: createMemoryFeaturesStore({ [STORE]: { marketing } }),
    now: () => NOW,
  });
}

test("coupon operations require both marketing permission and the store feature", async () => {
  const input = {
    campaign_id: CAMPAIGN,
    expected_version: 1,
    snapshot_id: SNAPSHOT,
    coupon_definition_id: COUPON,
  };
  await assert.rejects(
    () =>
      handlers()["marketing.campaign.coupons.preview"](
        context(
          "marketing.campaign.coupons.preview",
          input,
          Object.freeze({ ...ACTOR, permissions: Object.freeze([]) }),
        ),
      ),
    (error: unknown) =>
      error instanceof HandlerCommandError && error.commandError.code === "PERMISSION_DENIED",
  );
  await assert.rejects(
    () =>
      handlers(false)["marketing.campaign.coupons.preview"](
        context("marketing.campaign.coupons.preview", input),
      ),
    (error: unknown) =>
      error instanceof HandlerCommandError && error.commandError.code === "RESOURCE_UNAVAILABLE",
  );
});

test("coupon preview returns aggregate-only server authority", async () => {
  const outcome = await handlers()["marketing.campaign.coupons.preview"](
    context("marketing.campaign.coupons.preview", {
      campaign_id: CAMPAIGN,
      expected_version: 1,
      snapshot_id: SNAPSHOT,
      coupon_definition_id: COUPON,
    }),
  );
  const parsed = MarketingCouponIssuePreviewResultSchema.parse(outcome.result);
  assert.equal(parsed.preview.eligible_recipient_count, 1);
  assert.doesNotMatch(JSON.stringify(outcome), /customer_id|account_id|recipient_ids/iu);
});

test("coupon issue emits one aggregate audit and no recipient evidence", async () => {
  const input = {
    campaign_id: CAMPAIGN,
    expected_version: 1,
    snapshot_id: SNAPSHOT,
    coupon_definition_id: COUPON,
    reason: "八月回访",
  };
  const outcome = await handlers()["marketing.campaign.coupons.issue"](
    context(
      "marketing.campaign.coupons.issue",
      input,
      ACTOR,
      couponIssueConfirmationSummary(input, PREVIEW),
    ),
  );
  const parsed = MarketingCouponIssueResultSchema.parse(outcome.result);
  assert.equal(parsed.batch.batch_id, BATCH);
  assert.equal(outcome.audit?.entity, "marketing_coupon_batch");
  assert.equal(outcome.events?.[0]?.type, "marketing.coupon_batch_issued");
  assert.doesNotMatch(JSON.stringify(outcome.audit), /customer|account|recipient_ids/iu);
});

test("coupon redemption correction records both original and reversal ids", async () => {
  const input = { redemption_id: REDEMPTION, reason: "顾客误用" };
  const reversalPreview = Object.freeze({
    redemptionId: REDEMPTION,
    grantId: GRANT,
    orderId: ORDER,
    discountCents: 500,
    alreadyReversed: false,
  });
  const outcome = await handlers()["marketing.coupon.redemption.reverse"](
    context(
      "marketing.coupon.redemption.reverse",
      input,
      ACTOR,
      couponReversalConfirmationSummary(input, reversalPreview),
    ),
  );
  const parsed = MarketingCouponRedemptionReverseResultSchema.parse(outcome.result);
  assert.equal(parsed.reversal_id, REVERSAL);
  assert.equal(outcome.audit?.entity, "coupon_redemption_reversal");
  assert.match(outcome.audit?.beforeJson ?? "", new RegExp(REDEMPTION, "u"));
  assert.equal(outcome.events?.[0]?.type, "marketing.coupon_redemption_reversed");
});
