import { describe, expect, it } from "vitest";

import { computeOrderTotals, lineTotalCents } from "../pricing.js";
import { planPickup } from "../pickup-plan.js";
import { MAX_RECEIVE_GARMENTS, planReceive } from "../receive-plan.js";

describe("order pricing", () => {
  it("multiplies unit × qty in integer cents", () => {
    expect(lineTotalCents(1500, 3)).toBe(4500);
  });

  it("rejects paid over payable", () => {
    const result = computeOrderTotals([{ unit_price_cents: 1000, qty: 1 }], 1001);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("PAID_EXCEEDS_PAYABLE");
  });

  it("computes balance for partial pay", () => {
    const result = computeOrderTotals(
      [
        { unit_price_cents: 2000, qty: 2 },
        { unit_price_cents: 500, qty: 1 },
      ],
      1000,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.totals.subtotal_cents).toBe(4500);
    expect(result.totals.balance_cents).toBe(3500);
    expect(result.totals.garment_count).toBe(3);
  });
});

describe("planReceive", () => {
  it("expands qty into garment slots", () => {
    const plan = planReceive(
      [
        {
          service_code: "wash",
          category_code: "shirt",
          unit_price_cents: 1200,
          qty: 2,
          color: "white",
        },
        {
          service_code: "dry",
          category_code: "coat",
          unit_price_cents: 3000,
          qty: 1,
        },
      ],
      0,
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.slots).toHaveLength(3);
    expect(plan.slots[0]?.seq).toBe(1);
    expect(plan.slots[1]?.seq).toBe(2);
    expect(plan.slots[0]?.status).toBe("received");
    expect(plan.totals.payable_cents).toBe(5400);
  });

  it("rejects too many garments", () => {
    const plan = planReceive(
      [
        {
          service_code: "wash",
          category_code: "bulk",
          unit_price_cents: 100,
          qty: MAX_RECEIVE_GARMENTS + 1,
        },
      ],
      0,
    );
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toBe("TOO_MANY_GARMENTS");
  });
});

describe("planPickup", () => {
  const garments = [
    { garment_id: "g1", status: "received" as const },
    { garment_id: "g2", status: "received" as const },
    { garment_id: "g3", status: "picked_up" as const },
  ];

  it("selects all pickable when ids empty (collapsed fulfillment)", () => {
    const plan = planPickup({
      garments,
      selected_garment_ids: [],
      balance_cents: 500,
      collect_cents: 500,
      fulfillment_enabled: false,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.garment_ids).toEqual(["g1", "g2"]);
    expect(plan.to_status).toBe("picked_up");
  });

  it("rejects invalid transition for already picked garment", () => {
    const plan = planPickup({
      garments,
      selected_garment_ids: ["g3"],
      balance_cents: 0,
      collect_cents: 0,
      fulfillment_enabled: false,
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toBe("INVALID_TRANSITION");
  });

  it("rejects collect over balance", () => {
    const plan = planPickup({
      garments,
      selected_garment_ids: ["g1"],
      balance_cents: 100,
      collect_cents: 101,
      fulfillment_enabled: false,
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toBe("COLLECT_EXCEEDS_BALANCE");
  });
});
