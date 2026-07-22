import { describe, expect, it } from "vitest";

import {
  aggregateDaySummary,
  emptyDaySummary,
  localDateKeyFromDate,
  utcDateKeyFromEpoch,
} from "../day-summary.js";

describe("utcDateKeyFromEpoch / localDateKeyFromDate", () => {
  it("formats UTC day from epoch seconds", () => {
    // 2024-07-22T00:00:00.000Z
    expect(utcDateKeyFromEpoch(1_721_606_400)).toBe("2024-07-22");
  });

  it("formats local day from Date", () => {
    const key = localDateKeyFromDate(new Date(2026, 6, 22, 15, 0, 0));
    expect(key).toBe("2026-07-22");
  });
});

describe("aggregateDaySummary", () => {
  it("returns zeros for empty day", () => {
    expect(emptyDaySummary("2026-07-22")).toEqual({
      business_date: "2026-07-22",
      order_count: 0,
      garment_count: 0,
      payable_cents: 0,
      paid_cents: 0,
      balance_cents: 0,
      payment_cents: 0,
      picked_garment_count: 0,
    });
  });

  it("sums integer fen and counts garments / picked_up", () => {
    const summary = aggregateDaySummary({
      business_date: "2026-07-22",
      orders: Object.freeze([
        Object.freeze({ payable_cents: 3000, paid_cents: 500, balance_cents: 2500 }),
        Object.freeze({ payable_cents: 2000, paid_cents: 2000, balance_cents: 0 }),
      ]),
      garments: Object.freeze([
        Object.freeze({ status: "received" }),
        Object.freeze({ status: "picked_up" }),
        Object.freeze({ status: "picked_up" }),
        Object.freeze({ status: "ready" }),
      ]),
      payments: Object.freeze([
        Object.freeze({ amount_cents: 500, kind: "pay" }),
        Object.freeze({ amount_cents: 2000, kind: "pay" }),
        Object.freeze({ amount_cents: 100, kind: "refund" }),
      ]),
    });

    expect(summary).toEqual({
      business_date: "2026-07-22",
      order_count: 2,
      garment_count: 4,
      payable_cents: 5000,
      paid_cents: 2500,
      balance_cents: 2500,
      payment_cents: 2500,
      picked_garment_count: 2,
    });
  });

  it("treats missing payments as zero payment_cents", () => {
    const summary = aggregateDaySummary({
      business_date: "2026-07-22",
      orders: Object.freeze([
        Object.freeze({ payable_cents: 1000, paid_cents: 0, balance_cents: 1000 }),
      ]),
      garments: Object.freeze([Object.freeze({ status: "received" })]),
    });
    expect(summary.payment_cents).toBe(0);
    expect(summary.order_count).toBe(1);
    expect(summary.garment_count).toBe(1);
  });

  it("rejects non-integer fen", () => {
    expect(() =>
      aggregateDaySummary({
        business_date: "2026-07-22",
        orders: Object.freeze([
          Object.freeze({ payable_cents: 10.5, paid_cents: 0, balance_cents: 10.5 }),
        ]),
        garments: Object.freeze([]),
      }),
    ).toThrow(/integer/u);
  });

  it("rejects bad business_date", () => {
    expect(() =>
      aggregateDaySummary({
        business_date: "20260722",
        orders: Object.freeze([]),
        garments: Object.freeze([]),
      }),
    ).toThrow(/YYYY-MM-DD/u);
  });
});
