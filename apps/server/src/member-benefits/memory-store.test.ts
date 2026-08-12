import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createMemoryMemberStore } from "../member/memory-store.js";
import { createMemoryOrderStore } from "../order/memory-store.js";
import type { OrderRecord } from "../order/types.js";
import { createMemoryMemberBenefitsStore } from "./memory-store.js";

const ORG_ID = "10000000-0000-4000-8000-000000000001";
const STORE_ID = "10000000-0000-4000-8000-000000000002";
const STAFF_ID = "10000000-0000-4000-8000-000000000003";
const CUSTOMER_ID = "10000000-0000-4000-8000-000000000004";
const OTHER_CUSTOMER_ID = "10000000-0000-4000-8000-000000000005";
const ORDER_ID = "10000000-0000-4000-8000-000000000006";
const COUPON_ORDER_ID = "10000000-0000-4000-8000-000000000007";
const REUSED_COUPON_ORDER_ID = "10000000-0000-4000-8000-000000000008";

function idGenerator() {
  let value = 100;
  return () => `20000000-0000-4000-8000-${String(value++).padStart(12, "0")}`;
}

function order(
  orderId: string,
  customerId: string,
  status: "open" | "closed",
  paidCents: number,
): OrderRecord {
  return Object.freeze({
    order_id: orderId,
    org_id: ORG_ID,
    store_id: STORE_ID,
    ticket_no: "T-1",
    pickup_code: "123456",
    status,
    customer_id: customerId,
    customer_phone: "13800000000",
    customer_name: "会员",
    note: null,
    lines: Object.freeze([]),
    subtotal_cents: 3_000,
    original_cents: 3_000,
    discount_cents: 0,
    addon_cents: 0,
    urgent_cents: 0,
    freight_cents: 0,
    payable_cents: 3_000,
    paid_cents: paidCents,
    balance_cents: 3_000 - paidCents,
    created_at: 1_786_089_600,
    updated_at: 1_786_089_600,
    business_date: "2026-08-11",
    created_by_staff_id: STAFF_ID,
  });
}

async function setup() {
  const newId = idGenerator();
  const memberStore = createMemoryMemberStore({
    customerIds: [CUSTOMER_ID, OTHER_CUSTOMER_ID],
    newId,
  });
  const account = await memberStore.openAccount({
    customer_id: CUSTOMER_ID,
    store_id: STORE_ID,
    at: 1_786_089_600,
  });
  if (!account.ok) throw new Error(account.reason);
  const otherAccount = await memberStore.openAccount({
    customer_id: OTHER_CUSTOMER_ID,
    store_id: STORE_ID,
    at: 1_786_089_600,
  });
  if (!otherAccount.ok) throw new Error(otherAccount.reason);
  const orderStore = createMemoryOrderStore();
  await orderStore.insertOrder(order(ORDER_ID, CUSTOMER_ID, "closed", 3_000), []);
  await orderStore.insertOrder(order(COUPON_ORDER_ID, CUSTOMER_ID, "open", 0), []);
  return Object.freeze({
    memberStore,
    orderStore,
    accountId: account.value.account.account_id,
    otherAccountId: otherAccount.value.account.account_id,
    store: createMemoryMemberBenefitsStore({ orgId: ORG_ID, memberStore, orderStore, newId }),
  });
}

const evidence = Object.freeze({
  store_id: STORE_ID,
  staff_id: STAFF_ID,
  at: 1_786_089_600,
  business_date: "2026-08-11",
});

describe("ADR-41 memory member benefits", () => {
  it("versions definitions and memberships without expiring stored money", async () => {
    const runtime = await setup();
    const tier = await runtime.store.upsertDefinition({
      staff_id: STAFF_ID,
      at: evidence.at,
      definition: {
        kind: "tier",
        expected_version: 0,
        code: "gold",
        name: "金卡",
        level: 3,
        discount_bps: 500,
        status: "active",
      },
    });
    assert.equal(tier.ok, true);
    if (!tier.ok || tier.value.definition.kind !== "tier") return;
    assert.equal(tier.value.definition.version, 1);
    assert.deepEqual(
      await runtime.store.upsertDefinition({
        staff_id: STAFF_ID,
        at: evidence.at,
        definition: {
          kind: "tier",
          definition_id: tier.value.definition.definition_id,
          expected_version: 0,
          code: "gold",
          name: "旧页面",
          level: 2,
          discount_bps: 250,
          status: "active",
        },
      }),
      { ok: false, reason: "definition_version_conflict" },
    );

    const membership = await runtime.store.setMembership({
      ...evidence,
      account_id: runtime.accountId,
      expected_version: 0,
      tier_id: tier.value.definition.definition_id,
      valid_until: "2026-09-11",
      reason: "升级",
    });
    assert.equal(membership.ok, true);
    if (!membership.ok) return;
    assert.equal(membership.value.benefits.membership.version, 1);
    assert.equal(membership.value.benefits.membership.status, "active");
    const topup = await runtime.memberStore.topup({
      account_id: runtime.accountId,
      store_id: STORE_ID,
      amount_cents: 5_000,
      tender: "cash",
      staff_id: STAFF_ID,
      at: evidence.at,
      business_date: evidence.business_date,
      note: null,
    });
    assert.equal(topup.ok && topup.value.balance.total_cents, 5_000);
    const expiredView = await runtime.store.getBenefits({
      customer_id: CUSTOMER_ID,
      include_expired: true,
      business_date: "2026-10-01",
    });
    assert.equal(expiredView.ok && expiredView.value.membership.status, "expired");
    assert.equal(
      (await runtime.memberStore.getById(runtime.accountId, 10))?.balance.total_cents,
      5_000,
    );
  });

  it("earns once from settled value and redeems earliest-expiring credits", async () => {
    const runtime = await setup();
    await runtime.store.upsertDefinition({
      staff_id: STAFF_ID,
      at: evidence.at,
      definition: {
        kind: "points_policy",
        expected_version: 0,
        unit_cents: 100,
        points_per_unit: 2,
        valid_days: 30,
        status: "active",
      },
    });
    const earned = await runtime.store.earnPoints({
      ...evidence,
      account_id: runtime.accountId,
      order_id: ORDER_ID,
    });
    assert.equal(earned.ok && earned.value.benefits.points.available_points, 60);
    const replay = await runtime.store.earnPoints({
      ...evidence,
      account_id: runtime.accountId,
      order_id: ORDER_ID,
    });
    assert.equal(replay.ok && replay.value.changed, false);
    const redeemed = await runtime.store.redeemPoints({
      ...evidence,
      account_id: runtime.accountId,
      points: 25,
      reason: "兑换服务",
    });
    assert.equal(redeemed.ok && redeemed.value.benefits.points.available_points, 35);
    assert.deepEqual(
      await runtime.store.redeemPoints({
        ...evidence,
        account_id: runtime.accountId,
        points: 36,
        reason: "超额",
      }),
      { ok: false, reason: "insufficient_points" },
    );
    const afterExpiry = await runtime.store.getBenefits({
      customer_id: CUSTOMER_ID,
      include_expired: true,
      business_date: "2026-09-11",
    });
    assert.equal(afterExpiry.ok && afterExpiry.value.points.available_points, 0);
  });

  it("snapshots punch cards and refuses expiry, overuse and frozen accounts", async () => {
    const runtime = await setup();
    const definition = await runtime.store.upsertDefinition({
      staff_id: STAFF_ID,
      at: evidence.at,
      definition: {
        kind: "punch_type",
        expected_version: 0,
        code: "wash10",
        name: "十次卡",
        total_uses: 10,
        valid_days: 30,
        status: "active",
      },
    });
    if (!definition.ok || definition.value.definition.kind !== "punch_type") return;
    const grant = await runtime.store.grantAsset({
      ...evidence,
      asset_kind: "punch",
      account_id: runtime.accountId,
      definition_id: definition.value.definition.definition_id,
      reason: "购卡",
    });
    if (!grant.ok) return;
    const assetId = grant.value.benefits.punch_cards[0]?.asset_id;
    if (assetId === undefined) throw new Error("missing punch card");
    const used = await runtime.store.consumePunch({
      ...evidence,
      asset_id: assetId,
      uses: 3,
      reason: "洗衣",
    });
    assert.equal(used.ok, true);
    if (!used.ok) return;
    assert.equal(used.value.benefits.punch_cards[0]?.used_uses, 3);
    assert.equal(used.value.benefits.punch_cards[0]?.remaining_uses, 7);
    assert.deepEqual(
      await runtime.store.consumePunch({
        ...evidence,
        asset_id: assetId,
        uses: 8,
        reason: "超用",
      }),
      { ok: false, reason: "insufficient_uses" },
    );
    assert.deepEqual(
      await runtime.store.consumePunch({
        ...evidence,
        business_date: "2026-09-11",
        asset_id: assetId,
        uses: 1,
        reason: "过期",
      }),
      { ok: false, reason: "asset_expired" },
    );
    const frozen = await runtime.memberStore.transitionStatus({
      action: "freeze",
      account_id: runtime.accountId,
      expected_customer_id: CUSTOMER_ID,
      expected_status_version: 1,
      store_id: STORE_ID,
      staff_id: STAFF_ID,
      at: evidence.at + 1,
      reason: "挂失",
    });
    assert.equal(frozen.ok, true);
    assert.deepEqual(
      await runtime.store.consumePunch({
        ...evidence,
        asset_id: assetId,
        uses: 1,
        reason: "冻结后使用",
      }),
      { ok: false, reason: "account_frozen" },
    );
  });

  it("atomically applies one server-frozen coupon to an unpaid matching order", async () => {
    const runtime = await setup();
    const definition = await runtime.store.upsertDefinition({
      staff_id: STAFF_ID,
      at: evidence.at,
      definition: {
        kind: "coupon_type",
        expected_version: 0,
        code: "welcome",
        name: "迎新券",
        discount_cents: 500,
        min_order_cents: 1_000,
        valid_days: 30,
        status: "active",
      },
    });
    if (!definition.ok || definition.value.definition.kind !== "coupon_type") return;
    const grant = await runtime.store.grantAsset({
      ...evidence,
      asset_kind: "coupon",
      account_id: runtime.accountId,
      definition_id: definition.value.definition.definition_id,
      reason: "迎新",
    });
    if (!grant.ok) return;
    const assetId = grant.value.benefits.coupons[0]?.asset_id;
    if (assetId === undefined) throw new Error("missing coupon");
    const consumed = await runtime.store.consumeCoupon({
      ...evidence,
      asset_id: assetId,
      order_id: COUPON_ORDER_ID,
    });
    assert.equal(consumed.ok, true);
    if (!consumed.ok) return;
    assert.equal(consumed.value.benefits.coupons[0]?.status, "redeemed");
    assert.equal(consumed.value.benefits.coupons[0]?.redeemed_order_id, COUPON_ORDER_ID);
    const discountedOrder = await runtime.orderStore.getOrder(ORG_ID, STORE_ID, COUPON_ORDER_ID);
    assert.equal(discountedOrder?.discount_cents, 500);
    assert.equal(discountedOrder?.payable_cents, 2_500);
    assert.equal(discountedOrder?.balance_cents, 2_500);
    assert.deepEqual(
      await runtime.store.consumeCoupon({
        ...evidence,
        asset_id: assetId,
        order_id: COUPON_ORDER_ID,
      }),
      { ok: false, reason: "coupon_already_redeemed" },
    );
    const returned = await runtime.store.reverseCouponForOrder({
      order_id: COUPON_ORDER_ID,
      store_id: STORE_ID,
      staff_id: STAFF_ID,
      at: evidence.at + 1,
      reason: "客户取消",
    });
    assert.equal(returned.changed, true);
    assert.equal(returned.asset_id, assetId);
    const activeAgain = await runtime.store.getBenefits({
      customer_id: CUSTOMER_ID,
      include_expired: true,
      business_date: evidence.business_date,
    });
    assert.equal(activeAgain.ok && activeAgain.value.coupons[0]?.status, "active");
    if (!activeAgain.ok) return;
    assert.equal(activeAgain.value.coupons[0]?.redeemed_order_id, null);

    await runtime.orderStore.insertOrder(order(REUSED_COUPON_ORDER_ID, CUSTOMER_ID, "open", 0), []);
    const reused = await runtime.store.consumeCoupon({
      ...evidence,
      at: evidence.at + 2,
      asset_id: assetId,
      order_id: REUSED_COUPON_ORDER_ID,
    });
    assert.equal(reused.ok && reused.value.benefits.coupons[0]?.status, "redeemed");
    assert.equal(
      reused.ok && reused.value.benefits.coupons[0]?.redeemed_order_id,
      REUSED_COUPON_ORDER_ID,
    );
    assert.deepEqual(
      await runtime.store.reverseCouponForOrder({
        order_id: COUPON_ORDER_ID,
        store_id: STORE_ID,
        staff_id: STAFF_ID,
        at: evidence.at + 3,
        reason: "重复取消",
      }),
      { changed: false, asset_id: null, reversal_id: null },
    );
  });
});
