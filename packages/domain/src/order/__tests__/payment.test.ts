import { describe, expect, it } from "vitest";

import { buildPayPayment } from "../payment.js";

describe("buildPayPayment", () => {
  it("builds a kind=pay cash row with positive cents", () => {
    const row = buildPayPayment({
      payment_id: "pay-1",
      org_id: "org-1",
      store_id: "store-1",
      order_id: "order-1",
      amount_cents: 2500,
      staff_id: "staff-1",
      at: 1_700_000_000,
    });
    expect(row).toEqual({
      payment_id: "pay-1",
      org_id: "org-1",
      store_id: "store-1",
      order_id: "order-1",
      method: "cash",
      amount_cents: 2500,
      kind: "pay",
      ref_payment_id: null,
      staff_id: "staff-1",
      at: 1_700_000_000,
      note: null,
    });
  });

  it("rejects non-positive amount_cents", () => {
    expect(() =>
      buildPayPayment({
        payment_id: "pay-1",
        org_id: "org-1",
        store_id: "store-1",
        order_id: "order-1",
        amount_cents: 0,
        staff_id: "staff-1",
        at: 1,
      }),
    ).toThrow(/positive integer/u);
  });
});
