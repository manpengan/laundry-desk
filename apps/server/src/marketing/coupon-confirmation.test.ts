import assert from "node:assert/strict";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import type { ActorContext } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { MemoryPendingActionStore } from "../pending-actions/store.js";
import { createMemoryFeaturesStore } from "../platform/features.js";
import type { MarketingStore } from "./types.js";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CAMPAIGN = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SNAPSHOT = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const COUPON = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const REDEMPTION = "11111111-1111-4111-8111-111111111111";
const GRANT = "22222222-2222-4222-8222-222222222222";
const ORDER = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-08-13T02:00:00.000Z");
const TENANT: TenantContext = Object.freeze({ orgId: ORG, storeId: STORE, staffId: STAFF });
const ACTOR: ActorContext = Object.freeze({
  staffId: STAFF,
  deviceId: null,
  via: "ui",
  permissions: Object.freeze(["marketing_manage"]),
});

function store(): MarketingStore {
  return Object.freeze({
    setCampaign: async () => Object.freeze({ ok: false, reason: "missing" }),
    listCampaigns: async () => Object.freeze([]),
    getCampaign: async () => null,
    previewAudience: async () => null,
    freezeAudience: async () => Object.freeze({ ok: false, reason: "missing" }),
    previewCouponIssue: async () =>
      Object.freeze({
        ok: true,
        preview: Object.freeze({
          campaign_id: CAMPAIGN,
          campaign_version: 3,
          snapshot_id: SNAPSHOT,
          audience_digest: "a".repeat(64),
          coupon_definition_id: COUPON,
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
          evaluated_at: NOW.toISOString(),
        }),
      }),
    issueCoupons: async () => {
      throw new Error("first-hop confirmation must not mutate coupon grants");
    },
    getCouponBatch: async () => null,
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
    reverseCouponRedemption: async () => {
      throw new Error("first-hop confirmation must not reverse a redemption");
    },
  });
}

test("both R4 coupon commands expose only their server-frozen pending summaries", async () => {
  const pendingStore = new MemoryPendingActionStore();
  const bus = createRegisteredM1Bus(
    {
      marketing: Object.freeze({
        store: store(),
        features: createMemoryFeaturesStore({ [STORE]: { marketing: true } }),
        now: () => NOW,
      }),
    },
    pendingStore,
  );
  const sql = new FakeSqlClient();
  const issue = await executeCommand(
    sql,
    TENANT,
    "marketing.campaign.coupons.issue",
    {
      campaign_id: CAMPAIGN,
      expected_version: 3,
      snapshot_id: SNAPSHOT,
      coupon_definition_id: COUPON,
      reason: "八月回访",
    },
    { registry: bus.registry, actor: ACTOR, chainHooks: bus.chainHooks, pendingStore },
  );
  assert.equal(issue.ok, false, JSON.stringify(issue));
  if (issue.ok) return;
  assert.equal(issue.error.code, "POLICY_STEP_UP_REQUIRED");
  assert.deepEqual(
    issue.error.detail?.kind === "confirmation" ? issue.error.detail.summary : null,
    {
      kind: "marketing_coupon_issue",
      campaign_id: CAMPAIGN,
      campaign_version: 3,
      snapshot_id: SNAPSHOT,
      audience_digest: "a".repeat(64),
      coupon_definition_id: COUPON,
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
    },
  );

  const reversal = await executeCommand(
    sql,
    TENANT,
    "marketing.coupon.redemption.reverse",
    { redemption_id: REDEMPTION, reason: "顾客误用" },
    { registry: bus.registry, actor: ACTOR, chainHooks: bus.chainHooks, pendingStore },
  );
  assert.equal(reversal.ok, false, JSON.stringify(reversal));
  if (reversal.ok) return;
  assert.equal(reversal.error.code, "POLICY_STEP_UP_REQUIRED");
  assert.deepEqual(
    reversal.error.detail?.kind === "confirmation" ? reversal.error.detail.summary : null,
    {
      kind: "marketing_coupon_redemption_reversal",
      redemption_id: REDEMPTION,
      grant_id: GRANT,
      order_id: ORDER,
      reversed_discount_cents: 500,
      already_reversed: false,
      reason: "顾客误用",
    },
  );
});
