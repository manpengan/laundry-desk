import {
  OwnerDashboardDrilldownResultSchema,
  OwnerDashboardResultSchema,
  OwnerPortfolioResultSchema,
  type OwnerDashboardDrilldownResult,
  type OwnerDashboardResult,
  type OwnerPortfolioResult,
  type OwnerDashboardTrendPoint,
} from "@laundry/contracts";
import {
  aggregateOwnerCardMetrics,
  boundOwnerRows,
  completedAgeDays,
  type AccountingAggregation,
  type OwnerCardMetrics,
} from "@laundry/domain";

import {
  OWNER_DASHBOARD_OVERDUE_DAYS,
  OWNER_DASHBOARD_TREND_DAYS,
  shiftBusinessDate,
} from "./dates.js";
import type {
  OwnerDashboardDrilldownSnapshot,
  OwnerDashboardOperations,
  OwnerPortfolioStoreCandidate,
} from "./types.js";

export type BuildOwnerDashboardInput = Readonly<{
  businessDate: string;
  generatedAt: string;
  accounting: AccountingAggregation;
  operations: OwnerDashboardOperations;
}>;

export type OwnerPortfolioStoreSnapshot = Readonly<{
  store: OwnerPortfolioStoreCandidate;
  businessDate: string;
  metrics: OwnerCardMetrics;
}>;

export type BuildOwnerDrilldownInput = Readonly<{
  businessDate: string;
  generatedAt: string;
  snapshot: OwnerDashboardDrilldownSnapshot;
}>;

export type BuildOwnerPortfolioInput = Readonly<{
  generatedAt: string;
  stores: readonly OwnerPortfolioStoreSnapshot[];
  truncated: boolean;
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

export function buildOwnerCardMetrics(
  businessDate: string,
  accounting: AccountingAggregation,
  operations: OwnerDashboardOperations,
): OwnerCardMetrics {
  const unexpected = accounting.rows.find((row) => row.key !== businessDate);
  if (unexpected !== undefined) {
    throw new RangeError(`accounting row ${unexpected.key} is outside business date`);
  }
  const row = accounting.rows[0];
  return Object.freeze({
    performanceIncomeCents: row?.performance_income_cents ?? 0,
    realIncomeCents: row?.real_income_cents ?? 0,
    pickedUpGarmentCount: operations.pickedUpGarmentCount,
    newReceivableCents: operations.newReceivableCents,
    newReceivableOrderCount: operations.newReceivableOrderCount,
    overdueGarmentCount: operations.overdueGarmentCount,
    overdueOrderCount: operations.overdueOrderCount,
  });
}

function drilldownRows(
  input: BuildOwnerDrilldownInput,
): readonly Readonly<Record<string, unknown>>[] {
  const snapshot = input.snapshot;
  if (snapshot.kind === "today_pickups") {
    const bounded = boundOwnerRows(snapshot.rows, 50, snapshot.totalRowCount);
    return bounded.rows.map((row) =>
      Object.freeze({
        ticket_no: row.ticketNo,
        picked_at: row.pickedAt.toISOString(),
        garment_count: row.garmentCount,
      }),
    );
  }
  if (snapshot.kind === "new_receivables") {
    const bounded = boundOwnerRows(snapshot.rows, 50, snapshot.totalRowCount);
    return bounded.rows.map((row) =>
      Object.freeze({
        ticket_no: row.ticketNo,
        received_at: row.receivedAt.toISOString(),
        balance_cents: row.balanceCents,
      }),
    );
  }
  const generatedAt = new Date(input.generatedAt);
  const bounded = boundOwnerRows(snapshot.rows, 50, snapshot.totalRowCount);
  return bounded.rows.map((row) =>
    Object.freeze({
      ticket_no: row.ticketNo,
      received_at: row.receivedAt.toISOString(),
      age_days: completedAgeDays(generatedAt, row.receivedAt),
      garment_count: row.garmentCount,
      balance_cents: row.balanceCents,
    }),
  );
}

function drilldownTotals(
  snapshot: OwnerDashboardDrilldownSnapshot,
): Readonly<Record<string, number>> {
  if (snapshot.kind === "today_pickups") {
    return Object.freeze({
      picked_up_garment_count: snapshot.pickedUpGarmentCount,
      picked_up_order_count: snapshot.totalRowCount,
    });
  }
  if (snapshot.kind === "new_receivables") {
    return Object.freeze({
      new_receivable_cents: snapshot.newReceivableCents,
      new_receivable_order_count: snapshot.newReceivableOrderCount,
    });
  }
  return Object.freeze({
    overdue_garment_count: snapshot.overdueGarmentCount,
    overdue_order_count: snapshot.overdueOrderCount,
  });
}

export function buildOwnerDrilldownResult(
  input: BuildOwnerDrilldownInput,
): OwnerDashboardDrilldownResult {
  const returnedRowCount = Math.min(input.snapshot.rows.length, 50);
  if (input.snapshot.totalRowCount < returnedRowCount) {
    throw new RangeError("owner drilldown total cannot be smaller than returned rows");
  }
  const result = {
    business_date: input.businessDate,
    generated_at: input.generatedAt,
    kind: input.snapshot.kind,
    total_row_count: input.snapshot.totalRowCount,
    truncated: input.snapshot.totalRowCount > returnedRowCount,
    totals: drilldownTotals(input.snapshot),
    rows: drilldownRows(input),
    ...(input.snapshot.kind === "stagnant_garments"
      ? { overdue_min_age_days: OWNER_DASHBOARD_OVERDUE_DAYS }
      : {}),
  };
  return OwnerDashboardDrilldownResultSchema.parse(result);
}

function portfolioStore(snapshot: OwnerPortfolioStoreSnapshot): Readonly<Record<string, unknown>> {
  return Object.freeze({
    store_code: snapshot.store.storeCode,
    store_name: snapshot.store.storeName,
    timezone: snapshot.store.timeZone,
    business_date: snapshot.businessDate,
    performance_income_cents: snapshot.metrics.performanceIncomeCents,
    real_income_cents: snapshot.metrics.realIncomeCents,
    picked_up_garment_count: snapshot.metrics.pickedUpGarmentCount,
    new_receivable_cents: snapshot.metrics.newReceivableCents,
    new_receivable_order_count: snapshot.metrics.newReceivableOrderCount,
    overdue_garment_count: snapshot.metrics.overdueGarmentCount,
    overdue_order_count: snapshot.metrics.overdueOrderCount,
  });
}

function portfolioTotals(metrics: OwnerCardMetrics): Readonly<Record<string, number>> {
  return Object.freeze({
    performance_income_cents: metrics.performanceIncomeCents,
    real_income_cents: metrics.realIncomeCents,
    picked_up_garment_count: metrics.pickedUpGarmentCount,
    new_receivable_cents: metrics.newReceivableCents,
    new_receivable_order_count: metrics.newReceivableOrderCount,
    overdue_garment_count: metrics.overdueGarmentCount,
    overdue_order_count: metrics.overdueOrderCount,
  });
}

export function buildOwnerPortfolioResult(input: BuildOwnerPortfolioInput): OwnerPortfolioResult {
  const bounded = boundOwnerRows(input.stores, 50, input.stores.length + (input.truncated ? 1 : 0));
  const totals = aggregateOwnerCardMetrics(bounded.rows.map((store) => store.metrics));
  return OwnerPortfolioResultSchema.parse({
    generated_at: input.generatedAt,
    returned_store_count: bounded.rows.length,
    truncated: input.truncated,
    totals: portfolioTotals(totals),
    stores: bounded.rows.map(portfolioStore),
  });
}
