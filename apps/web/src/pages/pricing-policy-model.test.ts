import assert from "node:assert/strict";
import test from "node:test";

import {
  activePricingAddons,
  EMPTY_PRICING_POLICY,
  readPricingPolicy,
} from "./pricing-policy-model.js";

test("pricing policy parser accepts only the exact bus authority shape", () => {
  const policy = readPricingPolicy({
    execution: "executed",
    result: {
      policy: {
        version: 2,
        urgent_cents: 500,
        freight_cents: 300,
        addons: [
          {
            code: "stain",
            name: "去渍",
            unit_price_cents: 200,
            is_active: true,
            sort_order: 0,
          },
          {
            code: "old",
            name: "旧项",
            unit_price_cents: 100,
            is_active: false,
            sort_order: 1,
          },
        ],
        updated_at: 1_700_000_000,
      },
    },
  });
  assert.ok(policy);
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.addons), true);
  assert.deepEqual(
    activePricingAddons(policy).map((addon) => addon.code),
    ["stain"],
  );
  assert.equal(readPricingPolicy({ result: { policy: { ...policy, secret: "no" } } }), null);
  assert.equal(readPricingPolicy({ result: { policy: { ...policy, urgent_cents: 1.5 } } }), null);
});

test("empty pricing policy is immutable and represents an unconfigured store", () => {
  assert.equal(EMPTY_PRICING_POLICY.version, 0);
  assert.equal(Object.isFrozen(EMPTY_PRICING_POLICY), true);
  assert.deepEqual(EMPTY_PRICING_POLICY.addons, []);
});
