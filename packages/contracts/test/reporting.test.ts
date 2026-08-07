import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  OwnerDashboardInputSchema,
  OwnerDashboardResultSchema,
  reportingOwnerDashboardGetQuery,
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
