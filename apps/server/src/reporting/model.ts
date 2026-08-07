import {
  OwnerDashboardResultSchema,
  type OwnerDashboardResult,
  type OwnerDashboardTrendPoint,
} from "@laundry/contracts";
import type { AccountingAggregation } from "@laundry/domain";

import {
  OWNER_DASHBOARD_OVERDUE_DAYS,
  OWNER_DASHBOARD_TREND_DAYS,
  shiftBusinessDate,
} from "./dates.js";
import type { OwnerDashboardOperations } from "./types.js";

export type BuildOwnerDashboardInput = Readonly<{
  businessDate: string;
  generatedAt: string;
  accounting: AccountingAggregation;
  operations: OwnerDashboardOperations;
}>;

function trendDates(businessDate: string): readonly string[] {
  return Object.freeze(
    Array.from({ length: OWNER_DASHBOARD_TREND_DAYS }, (_, index) =>
      shiftBusinessDate(businessDate, index - (OWNER_DASHBOARD_TREND_DAYS - 1)),
    ),
  );
}

function accountingByDate(
  accounting: AccountingAggregation,
  acceptedDates: ReadonlySet<string>,
): ReadonlyMap<string, AccountingAggregation["rows"][number]> {
  const byDate = new Map<string, AccountingAggregation["rows"][number]>();
  for (const row of accounting.rows) {
    if (!acceptedDates.has(row.key)) {
      throw new RangeError(`accounting row ${row.key} is outside the 30-day window`);
    }
    if (byDate.has(row.key)) throw new TypeError(`duplicate accounting row ${row.key}`);
    byDate.set(row.key, row);
  }
  return byDate;
}

export function buildOwnerDashboardResult(input: BuildOwnerDashboardInput): OwnerDashboardResult {
  const dates = trendDates(input.businessDate);
  const byDate = accountingByDate(input.accounting, new Set(dates));
  const trend: readonly OwnerDashboardTrendPoint[] = Object.freeze(
    dates.map((businessDate) => {
      const row = byDate.get(businessDate);
      return Object.freeze({
        business_date: businessDate,
        performance_income_cents: row?.performance_income_cents ?? 0,
        real_income_cents: row?.real_income_cents ?? 0,
      });
    }),
  );
  const current = trend.at(-1);
  if (current === undefined) throw new TypeError("owner dashboard trend cannot be empty");

  return OwnerDashboardResultSchema.parse({
    business_date: input.businessDate,
    generated_at: input.generatedAt,
    overdue_min_age_days: OWNER_DASHBOARD_OVERDUE_DAYS,
    today: {
      performance_income_cents: current.performance_income_cents,
      real_income_cents: current.real_income_cents,
      picked_up_garment_count: input.operations.pickedUpGarmentCount,
      new_receivable_cents: input.operations.newReceivableCents,
      new_receivable_order_count: input.operations.newReceivableOrderCount,
      overdue_garment_count: input.operations.overdueGarmentCount,
      overdue_order_count: input.operations.overdueOrderCount,
    },
    trend,
  });
}
