import assert from "node:assert/strict";
import test from "node:test";

import { HandlerCommandError } from "../bus/types.js";
import type { StorePricingPolicy } from "../pricing/types.js";
import { requireLines, resolveTrustedPricing } from "./server-pricing.js";

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
