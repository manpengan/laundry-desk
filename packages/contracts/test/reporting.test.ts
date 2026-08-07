import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  OwnerDashboardInputSchema,
  OwnerDashboardDrilldownInputSchema,
  OwnerDashboardDrilldownResultSchema,
  OwnerDashboardResultSchema,
  OwnerPortfolioInputSchema,
  OwnerPortfolioResultSchema,
  reportingOwnerDashboardDrilldownQuery,
  reportingOwnerDashboardGetQuery,
  reportingOwnerPortfolioGetQuery,
} from "../src/commands/reporting.js";

function trendEndingAt(endDate: string) {
  const end = new Date(`${endDate}T12:00:00.000Z`);
  return Array.from({ length: 30 }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - (29 - index));
    return {
      business_date: date.toISOString().slice(0, 10),
      performance_income_cents: index === 29 ? 12_300 : 0,
      real_income_cents: index === 29 ? 10_000 : 0,
    };
  });
}

describe("ADR-26 owner dashboard contracts", () => {
  it("accepts only an empty input so tenant and dates stay server-owned", () => {
    expect(OwnerDashboardInputSchema.parse({})).toEqual({});
    expect(() => OwnerDashboardInputSchema.parse({ org_id: randomUUID() })).toThrow();
    expect(() => OwnerDashboardInputSchema.parse({ store_id: randomUUID() })).toThrow();
    expect(() => OwnerDashboardInputSchema.parse({ business_date: "2026-08-07" })).toThrow();
  });

  it("freezes an admin-authorized R1 read outside the AI projection", () => {
    expect(reportingOwnerDashboardGetQuery).toMatchObject({
      name: "reporting.owner_dashboard.get",
      version: "0.1.0",
      risk: "R1",
      invariants: ["rbac.accounting_read"],
      offline_mode: "denied",
      data_classification: "internal",
      max_result_rows: 30,
    });
  });

  it("validates four cards plus one consecutive 30-day dual-basis trend", () => {
    const value = {
      business_date: "2026-08-07",
      generated_at: "2026-08-07T05:00:00.000Z",
      overdue_min_age_days: 30,
      today: {
        performance_income_cents: 12_300,
        real_income_cents: 10_000,
        picked_up_garment_count: 7,
        new_receivable_cents: 4_500,
        new_receivable_order_count: 2,
        overdue_garment_count: 9,
        overdue_order_count: 4,
      },
      trend: trendEndingAt("2026-08-07"),
    };
    expect(OwnerDashboardResultSchema.parse(value)).toEqual(value);
    expect(
      OwnerDashboardResultSchema.safeParse({
        ...value,
        trend: value.trend.slice(1),
      }).success,
    ).toBe(false);
    expect(
      OwnerDashboardResultSchema.safeParse({
        ...value,
        trend: value.trend.map((row, index) =>
          index === 10 ? { ...row, business_date: "2026-01-01" } : row,
        ),
      }).success,
    ).toBe(false);
    expect(
      OwnerDashboardResultSchema.safeParse({
        ...value,
        today: { ...value.today, picked_up_garment_count: -1 },
      }).success,
    ).toBe(false);
  });
});

describe("owner dashboard read-only operations contracts", () => {
  it("accepts only the drilldown kind while keeping tenant, date and limit server-owned", () => {
    for (const kind of ["today_pickups", "new_receivables", "stagnant_garments"] as const) {
      expect(OwnerDashboardDrilldownInputSchema.parse({ kind })).toEqual({ kind });
    }
    expect(() => OwnerDashboardDrilldownInputSchema.parse({ kind: "outstanding_debt" })).toThrow();
    expect(() =>
      OwnerDashboardDrilldownInputSchema.parse({ kind: "today_pickups", store_id: randomUUID() }),
    ).toThrow();
    expect(() =>
      OwnerDashboardDrilldownInputSchema.parse({
        kind: "today_pickups",
        business_date: "2026-08-07",
      }),
    ).toThrow();
    expect(() =>
      OwnerDashboardDrilldownInputSchema.parse({ kind: "today_pickups", limit: 1 }),
    ).toThrow();
  });

  it("validates bounded, PII-minimized discriminated drilldowns", () => {
    const common = {
      business_date: "2026-08-07",
      generated_at: "2026-08-07T05:00:00.000Z",
      total_row_count: 1,
      truncated: false,
    };
    const pickup = {
      ...common,
      kind: "today_pickups",
      totals: { picked_up_garment_count: 2, picked_up_order_count: 1 },
      rows: [
        {
          ticket_no: "20260807-0001",
          picked_at: "2026-08-07T04:30:00.000Z",
          garment_count: 2,
        },
      ],
    };
    const receivables = {
      ...common,
      kind: "new_receivables",
      totals: { new_receivable_cents: 4_500, new_receivable_order_count: 1 },
      rows: [
        {
          ticket_no: "20260807-0002",
          received_at: "2026-08-07T04:00:00.000Z",
          balance_cents: 4_500,
        },
      ],
    };
    const stagnant = {
      ...common,
      kind: "stagnant_garments",
      overdue_min_age_days: 30,
      totals: { overdue_garment_count: 3, overdue_order_count: 1 },
      rows: [
        {
          ticket_no: "20260701-0001",
          received_at: "2026-07-01T02:00:00.000Z",
          age_days: 37,
          garment_count: 3,
          balance_cents: 0,
        },
      ],
    };

    for (const value of [pickup, receivables, stagnant]) {
      expect(OwnerDashboardDrilldownResultSchema.parse(value)).toEqual(value);
    }
    expect(
      OwnerDashboardDrilldownResultSchema.safeParse({
        ...receivables,
        rows: [{ ...receivables.rows[0], customer_phone: "13800000000" }],
      }).success,
    ).toBe(false);
    expect(
      OwnerDashboardDrilldownResultSchema.safeParse({
        ...pickup,
        total_row_count: 51,
        truncated: false,
      }).success,
    ).toBe(false);
    expect(
      OwnerDashboardDrilldownResultSchema.safeParse({
        ...stagnant,
        totals: { overdue_garment_count: 2, overdue_order_count: 1 },
      }).success,
    ).toBe(false);
  });

  it("freezes the drilldown as one internal accounting read outside AI projection", () => {
    expect(reportingOwnerDashboardDrilldownQuery).toMatchObject({
      name: "reporting.owner_dashboard.drilldown",
      version: "0.1.0",
      risk: "R1",
      invariants: ["rbac.accounting_read"],
      offline_mode: "denied",
      data_classification: "internal",
      max_result_rows: 50,
    });
  });

  it("keeps the portfolio input empty and validates only authorized store-safe fields", () => {
    expect(OwnerPortfolioInputSchema.parse({})).toEqual({});
    expect(() => OwnerPortfolioInputSchema.parse({ org_id: randomUUID() })).toThrow();
    expect(() => OwnerPortfolioInputSchema.parse({ store_ids: [randomUUID()] })).toThrow();
    expect(() => OwnerPortfolioInputSchema.parse({ business_date: "2026-08-07" })).toThrow();

    const store = {
      store_code: "main",
      store_name: "主店",
      timezone: "Asia/Shanghai",
      business_date: "2026-08-07",
      performance_income_cents: 12_300,
      real_income_cents: 10_000,
      picked_up_garment_count: 7,
      new_receivable_cents: 4_500,
      new_receivable_order_count: 2,
      overdue_garment_count: 9,
      overdue_order_count: 4,
    };
    const value = {
      generated_at: "2026-08-07T05:00:00.000Z",
      returned_store_count: 1,
      truncated: false,
      totals: {
        performance_income_cents: 12_300,
        real_income_cents: 10_000,
        picked_up_garment_count: 7,
        new_receivable_cents: 4_500,
        new_receivable_order_count: 2,
        overdue_garment_count: 9,
        overdue_order_count: 4,
      },
      stores: [store],
    };
    expect(OwnerPortfolioResultSchema.parse(value)).toEqual(value);
    expect(
      OwnerPortfolioResultSchema.safeParse({
        ...value,
        stores: [{ ...store, store_id: randomUUID() }],
      }).success,
    ).toBe(false);
    expect(
      OwnerPortfolioResultSchema.safeParse({ ...value, returned_store_count: 51 }).success,
    ).toBe(false);
  });

  it("freezes the portfolio as a bounded internal accounting read", () => {
    expect(reportingOwnerPortfolioGetQuery).toMatchObject({
      name: "reporting.owner_portfolio.get",
      version: "0.1.0",
      risk: "R1",
      invariants: ["rbac.accounting_read"],
      offline_mode: "denied",
      data_classification: "internal",
      max_result_rows: 50,
    });
  });
});
