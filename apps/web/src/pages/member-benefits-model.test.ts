import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_BENEFIT_DEFINITION_DRAFT,
  benefitDefinitionDraft,
  buildBenefitDefinitionBody,
  buildCouponConsumeBody,
  buildPointsEarnBody,
  formatBenefitDiscountPercent,
  parseMemberBenefitCatalog,
  parseMemberBenefits,
} from "./member-benefits-model.js";

const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CUSTOMER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORDER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ASSET_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

test("points earn and coupon consume bodies cannot carry client-calculated amounts", () => {
  const earnBody = buildPointsEarnBody(ACCOUNT_ID, ORDER_ID);
  const couponBody = buildCouponConsumeBody(ASSET_ID, ORDER_ID);
  assert.notEqual(couponBody, null);
  assert.deepEqual(earnBody, {
    account_id: ACCOUNT_ID,
    order_id: ORDER_ID,
  });
  assert.deepEqual(couponBody, {
    asset: { asset_kind: "coupon", asset_id: ASSET_ID, order_id: ORDER_ID },
  });
  assert.equal("points" in earnBody, false);
  assert.equal("discount_cents" in couponBody!, false);
});

test("definition builder creates strict typed definitions and rejects invalid drafts", () => {
  assert.deepEqual(
    buildBenefitDefinitionBody({
      ...EMPTY_BENEFIT_DEFINITION_DRAFT,
      code: "gold",
      name: "金卡",
      primary: "2",
      secondary: "8.75",
    }),
    {
      definition: {
        kind: "tier",
        expected_version: 0,
        status: "active",
        code: "gold",
        name: "金卡",
        level: 2,
        discount_bps: 875,
      },
    },
  );
  assert.deepEqual(
    buildBenefitDefinitionBody({
      ...EMPTY_BENEFIT_DEFINITION_DRAFT,
      kind: "coupon_type",
      code: "welcome_10",
      name: "新客券",
      primary: "10.00",
      secondary: "50",
      validDays: "30",
    }),
    {
      definition: {
        kind: "coupon_type",
        expected_version: 0,
        status: "active",
        code: "welcome_10",
        name: "新客券",
        discount_cents: 1_000,
        min_order_cents: 5_000,
        valid_days: 30,
      },
    },
  );
  assert.equal(
    buildBenefitDefinitionBody({
      ...EMPTY_BENEFIT_DEFINITION_DRAFT,
      kind: "tier",
      code: "bad code",
      name: "等级",
      primary: "1",
    }),
    null,
  );
  assert.equal(
    buildBenefitDefinitionBody({
      ...EMPTY_BENEFIT_DEFINITION_DRAFT,
      code: "bad_discount",
      name: "等级",
      primary: "1",
      secondary: "100.01",
    }),
    null,
  );
  const tierDraft = benefitDefinitionDraft({
    kind: "tier",
    definition_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    code: "silver",
    name: "银卡",
    level: 1,
    discount_bps: 800,
    status: "active",
    version: 3,
    note: null,
  });
  assert.equal(tierDraft.secondary, "8");
  assert.equal(formatBenefitDiscountPercent(875), "8.75");
});

test("catalog and benefits parsers reject extra authority fields", () => {
  assert.deepEqual(
    parseMemberBenefitCatalog({
      result: { tiers: [], points_policy: null, punch_types: [], coupon_types: [] },
    }),
    { tiers: [], points_policy: null, punch_types: [], coupon_types: [] },
  );
  const benefits = {
    account_id: ACCOUNT_ID,
    customer_id: CUSTOMER_ID,
    account_status: "active",
    membership: { version: 0, tier: null, valid_until: null, status: "unassigned" },
    points: { available_points: 0, lifetime_earned_points: 0, recent: [] },
    punch_cards: [],
    coupons: [],
  };
  assert.deepEqual(parseMemberBenefits({ result: benefits }), benefits);
  assert.equal(parseMemberBenefits({ result: { ...benefits, org_id: "forbidden" } }), null);
  assert.equal(
    parseMemberBenefitCatalog({
      result: { tiers: [], points_policy: null, punch_types: [], coupon_types: [], secret: true },
    }),
    null,
  );
});
