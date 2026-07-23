import { describe, expect, it } from "vitest";

import { computeFivePartPricing, computeOrderTotals } from "../pricing.js";

describe("M2 five-part pricing", () => {
  it("derives payable from original, discount, addon, urgent and freight cents", () => {
    expect(
      computeFivePartPricing({
        original_cents: 10_000,
        discount_cents: 1_500,
        addon_cents: 400,
        urgent_cents: 600,
        freight_cents: 800,
      }),
    ).toEqual({ ok: true, payable_cents: 10_300 });
  });

  it("fails closed for discount over original or unsafe cents", () => {
    expect(
      computeFivePartPricing({
        original_cents: 100,
        discount_cents: 101,
        addon_cents: 0,
        urgent_cents: 0,
        freight_cents: 0,
      }),
    ).toEqual({ ok: false, reason: "DISCOUNT_EXCEEDS_ORIGINAL" });
    expect(
      computeFivePartPricing({
        original_cents: Number.MAX_SAFE_INTEGER,
        discount_cents: 0,
        addon_cents: 1,
        urgent_cents: 0,
        freight_cents: 0,
      }),
    ).toEqual({ ok: false, reason: "UNSAFE_CENTS" });
  });

  it("uses the same five-part computation for line-derived order totals", () => {
    const result = computeOrderTotals(
      [
        { unit_price_cents: 2_000, qty: 2 },
        { unit_price_cents: 500, qty: 1 },
      ],
      1_000,
      { discount_cents: 300, addon_cents: 150, urgent_cents: 200, freight_cents: 50 },
    );
    expect(result).toEqual({
      ok: true,
      totals: {
        original_cents: 4_500,
        subtotal_cents: 4_500,
        discount_cents: 300,
        addon_cents: 150,
        urgent_cents: 200,
        freight_cents: 50,
        payable_cents: 4_600,
        paid_cents: 1_000,
        balance_cents: 3_600,
        garment_count: 3,
      },
    });
  });

  it("fails closed before an unsafe line multiplication or cumulative amount", () => {
    expect(computeOrderTotals([{ unit_price_cents: Number.MAX_SAFE_INTEGER, qty: 2 }], 0)).toEqual({
      ok: false,
      reason: "UNSAFE_CENTS",
    });
    expect(computeOrderTotals([{ unit_price_cents: 100, qty: 1 }], 0.5)).toEqual({
      ok: false,
      reason: "UNSAFE_CENTS",
    });
  });
});
