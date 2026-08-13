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

const ID = Object.freeze({
  org: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  store: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  staff: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  campaign: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  referrer: "11111111-1111-4111-8111-111111111111",
  referred: "22222222-2222-4222-8222-222222222222",
  referrerAccount: "33333333-3333-4333-8333-333333333333",
  referredAccount: "44444444-4444-4444-8444-444444444444",
  order: "55555555-5555-4555-8555-555555555555",
  coupon: "66666666-6666-4666-8666-666666666666",
  voucher: "77777777-7777-4777-8777-777777777777",
});
const NOW = new Date("2026-08-13T02:00:00.000Z");
const DIGEST = "a".repeat(64);
const TENANT: TenantContext = Object.freeze({
  orgId: ID.org,
  storeId: ID.store,
  staffId: ID.staff,
});
const ACTOR: ActorContext = Object.freeze({
  staffId: ID.staff,
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
    previewCouponIssue: async () => Object.freeze({ ok: false, reason: "missing" }),
    issueCoupons: async () => Object.freeze({ ok: false, reason: "missing" }),
    getCouponBatch: async () => null,
    previewCouponRedemptionReversal: async () => Object.freeze({ ok: false, reason: "missing" }),
    reverseCouponRedemption: async () => Object.freeze({ ok: false, reason: "missing" }),
    previewReferralReward: async () =>
      Object.freeze({
        ok: true,
        authority: Object.freeze({
          kind: "marketing_referral_reward" as const,
          campaign_id: ID.campaign,
          campaign_version: 3,
          referrer_customer_id: ID.referrer,
          referrer_account_id: ID.referrerAccount,
          referred_customer_id: ID.referred,
          referred_account_id: ID.referredAccount,
          qualifying_order_id: ID.order,
          coupon_definition_id: ID.coupon,
          coupon_version: 2,
          coupon_code: "referral_5",
          coupon_name: "推荐五元券",
          coupon_discount_cents: 500,
          coupon_min_order_cents: 2_000,
          coupon_valid_days: 30,
          budget_remaining_cents: 9_000,
          reason: "首单推荐",
        }),
      }),
    issueReferralReward: async () => {
      throw new Error("first hop must not issue a referral reward");
    },
    previewGroupBuyRegistration: async () =>
      Object.freeze({
        ok: true,
        authority: Object.freeze({
          kind: "marketing_group_buy_registration" as const,
          code_digest: DIGEST,
          code_last4: "2345",
          provider: "meituan" as const,
          external_order_ref: "mt-1",
          label: "团购洗护券",
          face_value_cents: 5_000,
          expires_at: "2026-09-01T00:00:00.000Z",
          reason: "平台售出",
        }),
      }),
    registerGroupBuyVoucher: async () => {
      throw new Error("first hop must not register a group-buy voucher");
    },
    previewGroupBuyRedemption: async () =>
      Object.freeze({
        ok: true,
        authority: Object.freeze({
          kind: "marketing_group_buy_redemption" as const,
          voucher_id: ID.voucher,
          code_digest: DIGEST,
          code_last4: "2345",
          provider: "meituan" as const,
          external_order_ref: "mt-1",
          label: "团购洗护券",
          face_value_cents: 5_000,
          expires_at: "2026-09-01T00:00:00.000Z",
          order_id: ID.order,
          order_original_cents: 8_000,
          order_payable_before_cents: 8_000,
          applied_discount_cents: 5_000,
          reason: "前台核销",
        }),
      }),
    redeemGroupBuyVoucher: async () => {
      throw new Error("first hop must not redeem a group-buy voucher");
    },
  });
}

test("Item 9 R4 cards freeze authority without account ids or voucher digest projections", async () => {
  const pendingStore = new MemoryPendingActionStore();
  const bus = createRegisteredM1Bus(
    {
      marketing: Object.freeze({
        store: store(),
        features: createMemoryFeaturesStore({ [ID.store]: { marketing: true } }),
        now: () => NOW,
      }),
    },
    pendingStore,
  );
  const sql = new FakeSqlClient();
  const commands = Object.freeze([
    Object.freeze({
      name: "marketing.referral.reward.issue",
      input: Object.freeze({
        campaign_id: ID.campaign,
        expected_version: 3,
        referrer_customer_id: ID.referrer,
        referred_customer_id: ID.referred,
        qualifying_order_id: ID.order,
        coupon_definition_id: ID.coupon,
        reason: "首单推荐",
      }),
    }),
    Object.freeze({
      name: "marketing.group_buy.voucher.register",
      input: Object.freeze({
        provider: "meituan",
        external_order_ref: "mt-1",
        voucher_code_digest: DIGEST,
        voucher_code_last4: "2345",
        label: "团购洗护券",
        face_value_cents: 5_000,
        expires_at: "2026-09-01T00:00:00.000Z",
        reason: "平台售出",
      }),
    }),
    Object.freeze({
      name: "marketing.group_buy.voucher.redeem",
      input: Object.freeze({
        voucher_code_digest: DIGEST,
        order_id: ID.order,
        reason: "前台核销",
      }),
    }),
  ]);

  for (const command of commands) {
    const result = await executeCommand(sql, TENANT, command.name, command.input, {
      registry: bus.registry,
      actor: ACTOR,
      chainHooks: bus.chainHooks,
      pendingStore,
    });
    assert.equal(result.ok, false, JSON.stringify(result));
    if (result.ok) continue;
    assert.equal(result.error.code, "POLICY_STEP_UP_REQUIRED");
    const detail = result.error.detail?.kind === "confirmation" ? result.error.detail : null;
    assert.ok(detail);
    const serializedSummary = JSON.stringify(detail.summary);
    assert.doesNotMatch(serializedSummary, new RegExp(ID.referrerAccount, "u"));
    assert.doesNotMatch(serializedSummary, new RegExp(ID.referredAccount, "u"));
    assert.doesNotMatch(serializedSummary, new RegExp(DIGEST, "u"));
    const card = pendingStore.get(detail.confirm_ref);
    assert.ok(card);
    assert.doesNotMatch(JSON.stringify(card), /ABCD2345EFGH6789JKLM2345/u);
  }
});
