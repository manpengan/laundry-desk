import assert from "node:assert/strict";
import test from "node:test";

import { HandlerCommandError } from "../bus/types.js";
import type { CustomerOrderPolicySnapshot } from "../customer-profile/order-policy.js";
import type { StorePricingPolicy } from "../pricing/types.js";
import {
  assertReplayCustomerPolicy,
  requireLines,
  resolveCustomerPolicyPricing,
  resolveTrustedPricing,
} from "./server-pricing.js";

const POLICY: StorePricingPolicy = Object.freeze({
  version: 4,
  urgent_cents: 500,
  freight_cents: 300,
  addons: Object.freeze([
    Object.freeze({
      code: "stain",
      name: "去渍",
      unit_price_cents: 200,
      is_active: true,
      sort_order: 0,
    }),
    Object.freeze({
      code: "retired",
      name: "已停用",
      unit_price_cents: 9_999,
      is_active: false,
      sort_order: 1,
    }),
  ]),
  updated_at: 1_700_000_000,
});

const pricedLines = () =>
  Object.freeze(
    requireLines([
      {
        service_code: "wash",
        category_code: "shirt",
        qty: 2,
        garments: [
          { color: "白", defects: ["袖口污渍"], addon_codes: ["stain"] },
          { brand: "示例品牌", accessories: ["腰带"] },
        ],
      },
    ]).map((line) => Object.freeze({ ...line, unit_price_cents: 1_500 })),
  );

function customerPolicy(
  customerDiscountBps: number | null,
  tierDiscountBps = 0,
): CustomerOrderPolicySnapshot {
  return Object.freeze({
    customer_profile_version: 3,
    customer_discount_bps: customerDiscountBps,
    membership_version: tierDiscountBps > 0 ? 2 : null,
    tier:
      tierDiscountBps > 0
        ? Object.freeze({
            tier_id: "10000000-0000-4000-8000-000000000001",
            definition_version: 4,
            code: "gold",
            name: "Gold",
            level: 10,
            discount_bps: tierDiscountBps,
          })
        : null,
    waivers: Object.freeze({
      skip_ticket_print: false,
      skip_label_print: false,
      skip_rack_assignment: false,
    }),
  });
}

test("trusted pricing resolves active per-piece add-ons and fixed store fees", () => {
  const plan = resolveTrustedPricing(
    {
      discount_cents: 100,
      urgent: true,
      freight: true,
      // ADR-38 compatibility fields are intentionally hostile and ignored.
      addon_cents: 900_000,
      urgent_cents: 800_000,
      freight_cents: 700_000,
    },
    pricedLines(),
    POLICY,
    ["order_write", "order_discount"],
  );

  assert.deepEqual(plan.adjustments, {
    discount_cents: 100,
    addon_cents: 200,
    urgent_cents: 500,
    freight_cents: 300,
  });
  assert.equal(plan.pricing_policy_version, 4);
  assert.equal(plan.lines[0]?.garment_details[0]?.addons[0]?.name, "去渍");
  assert.deepEqual(plan.lines[0]?.garment_details[0]?.defects, ["袖口污渍"]);
});

test("non-zero manual discount fails closed without order_discount", () => {
  assert.throws(
    () => resolveTrustedPricing({ discount_cents: 1 }, pricedLines(), POLICY, ["order_write"]),
    (error: unknown) =>
      error instanceof HandlerCommandError && error.commandError.code === "PERMISSION_DENIED",
  );
});

test("unknown or inactive add-on codes cannot be priced", () => {
  for (const code of ["unknown", "retired"]) {
    const lines = Object.freeze(
      requireLines([
        {
          service_code: "wash",
          category_code: "shirt",
          qty: 1,
          garments: [{ addon_codes: [code] }],
        },
      ]).map((line) => Object.freeze({ ...line, unit_price_cents: 1_500 })),
    );
    assert.throws(
      () => resolveTrustedPricing({}, lines, POLICY, ["order_write"]),
      (error: unknown) =>
        error instanceof HandlerCommandError && error.commandError.code === "VALIDATION_FAILED",
    );
  }
});

test("customer policy discount priority is manual then customer then tier", () => {
  const base = resolveTrustedPricing({}, pricedLines(), POLICY, ["order_write"]);
  const tier = resolveCustomerPolicyPricing(base, customerPolicy(null, 1_000));
  assert.equal(tier.discount_source, "tier");
  assert.equal(tier.discount_bps, 1_000);
  assert.equal(tier.adjustments.discount_cents, 300);

  const customer = resolveCustomerPolicyPricing(base, customerPolicy(1_250, 1_000));
  assert.equal(customer.discount_source, "customer");
  assert.equal(customer.discount_bps, 1_250);
  assert.equal(customer.adjustments.discount_cents, 375);

  const manual = resolveCustomerPolicyPricing(
    resolveTrustedPricing({ discount_cents: 99 }, pricedLines(), POLICY, ["order_discount"]),
    customerPolicy(1_250, 1_000),
  );
  assert.equal(manual.discount_source, "manual");
  assert.equal(manual.discount_bps, 0);
  assert.equal(manual.adjustments.discount_cents, 99);
});

test("explicit customer zero blocks tier inheritance and basis points floor exactly", () => {
  const blocked = resolveCustomerPolicyPricing(
    resolveTrustedPricing({}, pricedLines(), POLICY, ["order_write"]),
    customerPolicy(0, 2_000),
  );
  assert.equal(blocked.discount_source, "customer");
  assert.equal(blocked.discount_bps, 0);
  assert.equal(blocked.adjustments.discount_cents, 0);

  const oddCentLine = Object.freeze([
    Object.freeze({ ...pricedLines()[0]!, qty: 1, unit_price_cents: 1_999 }),
  ]);
  const floored = resolveCustomerPolicyPricing(
    resolveTrustedPricing({}, oddCentLine, POLICY, ["order_write"]),
    customerPolicy(1_250),
  );
  assert.equal(floored.adjustments.discount_cents, 249);
});

test("edge replay fails closed when mutable customer policy affects arbitration", () => {
  assert.throws(
    () => assertReplayCustomerPolicy("edge_replay", customerPolicy(0)),
    (error: unknown) =>
      error instanceof HandlerCommandError &&
      error.commandError.code === "REPLAY_ARBITRATION_REQUIRED",
  );
  assert.doesNotThrow(() => assertReplayCustomerPolicy("edge_replay", null));
});
