import { describe, expect, it } from "vitest";

import { planOrderClosure } from "../lifecycle.js";

describe("order closing invariant", () => {
  it("closes only when all garments are terminal and balance is exactly zero", () => {
    expect(
      planOrderClosure({
        status: "open",
        garment_statuses: ["picked_up", "delivered", "lost"],
        balance_cents: 0,
      }),
    ).toEqual({ ok: true, next_status: "closed", can_close: true });

    expect(
      planOrderClosure({
        status: "open",
        garment_statuses: ["picked_up", "received"],
        balance_cents: 0,
      }),
    ).toEqual({ ok: true, next_status: "open", can_close: false });
  });

  it("fails closed for an invalid existing state or balance", () => {
    expect(
      planOrderClosure({ status: "closed", garment_statuses: ["picked_up"], balance_cents: 0 }),
    ).toEqual({ ok: false, reason: "ORDER_NOT_OPEN" });
    expect(
      planOrderClosure({ status: "open", garment_statuses: ["picked_up"], balance_cents: -1 }),
    ).toEqual({ ok: false, reason: "INVALID_BALANCE" });
    expect(planOrderClosure({ status: "open", garment_statuses: [], balance_cents: 0 })).toEqual({
      ok: false,
      reason: "EMPTY_GARMENTS",
    });
  });
});
