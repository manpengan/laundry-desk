import { describe, expect, it } from "vitest";

import {
  aggregateOwnerCardMetrics,
  boundOwnerRows,
  completedAgeDays,
  type OwnerCardMetrics,
} from "../reporting/index.js";

const ZERO: OwnerCardMetrics = Object.freeze({
  performanceIncomeCents: 0,
  realIncomeCents: 0,
  pickedUpGarmentCount: 0,
  newReceivableCents: 0,
  newReceivableOrderCount: 0,
  overdueGarmentCount: 0,
  overdueOrderCount: 0,
});

describe("owner reporting domain model", () => {
  it("aggregates the exact ADR-26 card fields without mutating store rows", () => {
    const first = Object.freeze({
      ...ZERO,
      performanceIncomeCents: 1_200,
      realIncomeCents: 1_000,
      pickedUpGarmentCount: 2,
    });
    const second = Object.freeze({
      ...ZERO,
      performanceIncomeCents: -200,
      newReceivableCents: 4_500,
      newReceivableOrderCount: 1,
      overdueGarmentCount: 3,
      overdueOrderCount: 1,
    });

    expect(aggregateOwnerCardMetrics([first, second])).toEqual({
      performanceIncomeCents: 1_000,
      realIncomeCents: 1_000,
      pickedUpGarmentCount: 2,
      newReceivableCents: 4_500,
      newReceivableOrderCount: 1,
      overdueGarmentCount: 3,
      overdueOrderCount: 1,
    });
    expect(first.performanceIncomeCents).toBe(1_200);
    expect(second.newReceivableCents).toBe(4_500);
  });

  it("bounds returned rows while preserving the full total row count", () => {
    const rows = Object.freeze(Array.from({ length: 51 }, (_, index) => Object.freeze({ index })));
    const bounded = boundOwnerRows(rows, 50);
    expect(bounded.rows).toHaveLength(50);
    expect(bounded.totalRowCount).toBe(51);
    expect(bounded.truncated).toBe(true);
    expect(() => boundOwnerRows(rows, 0)).toThrow(/positive safe integer/u);
  });

  it("calculates only completed 24-hour age buckets and rejects future timestamps", () => {
    const now = new Date("2026-08-07T18:30:00.000Z");
    expect(completedAgeDays(now, new Date("2026-07-08T18:30:00.000Z"))).toBe(30);
    expect(completedAgeDays(now, new Date("2026-07-08T18:30:00.001Z"))).toBe(29);
    expect(() => completedAgeDays(now, new Date("2026-08-07T18:30:00.001Z"))).toThrow(/future/u);
  });

  it("fails closed before integer totals overflow", () => {
    expect(() =>
      aggregateOwnerCardMetrics([
        Object.freeze({ ...ZERO, performanceIncomeCents: Number.MAX_SAFE_INTEGER }),
        Object.freeze({ ...ZERO, performanceIncomeCents: 1 }),
      ]),
    ).toThrow(/safe integer/u);
  });
});
