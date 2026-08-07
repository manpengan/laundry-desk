import assert from "node:assert/strict";
import test from "node:test";

import { aggregateAccountingReport, type AccountingMovement } from "@laundry/domain";

import {
  buildOwnerDashboardResult,
  buildOwnerDrilldownResult,
  buildOwnerPortfolioResult,
} from "./model.js";

const STAFF_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function movement(
  businessDate: string,
  source: AccountingMovement["source"],
  method: AccountingMovement["method"],
  netCents: number,
): AccountingMovement {
  return Object.freeze({
    source,
    business_date: businessDate,
    staff_id: STAFF_ID,
    staff_name: "店长",
    method,
    net_cents: netCents,
    ledger_row_count: 1,
  });
}

test("owner dashboard produces exactly 30 consecutive days and fills ledger gaps with zero", () => {
  const accounting = aggregateAccountingReport(
    [
      movement("2026-07-10", "order", "cash", 500),
      movement("2026-08-07", "order", "balance", 1_200),
      movement("2026-08-07", "stored_value", "cash", 3_000),
    ],
    "day",
  );
  const result = buildOwnerDashboardResult({
    businessDate: "2026-08-07",
    generatedAt: "2026-08-07T18:30:00.000Z",
    accounting,
    operations: Object.freeze({
      pickedUpGarmentCount: 7,
      newReceivableCents: 4_500,
      newReceivableOrderCount: 2,
      overdueGarmentCount: 9,
      overdueOrderCount: 4,
    }),
  });

  assert.equal(result.trend.length, 30);
  assert.equal(result.trend[0]?.business_date, "2026-07-09");
  assert.deepEqual(result.trend[1], {
    business_date: "2026-07-10",
    performance_income_cents: 500,
    real_income_cents: 500,
  });
  assert.deepEqual(result.trend.at(-1), {
    business_date: "2026-08-07",
    performance_income_cents: 1_200,
    real_income_cents: 3_000,
  });
  assert.equal(result.today.performance_income_cents, 1_200);
  assert.equal(result.today.real_income_cents, 3_000);
  assert.equal(result.today.picked_up_garment_count, 7);
  assert.equal(result.today.new_receivable_cents, 4_500);
  assert.equal(result.today.overdue_order_count, 4);
});

test("owner dashboard rejects accounting rows outside its requested window", () => {
  const accounting = aggregateAccountingReport(
    [movement("2026-07-08", "order", "cash", 500)],
    "day",
  );
  assert.throws(
    () =>
      buildOwnerDashboardResult({
        businessDate: "2026-08-07",
        generatedAt: "2026-08-07T18:30:00.000Z",
        accounting,
        operations: Object.freeze({
          pickedUpGarmentCount: 0,
          newReceivableCents: 0,
          newReceivableOrderCount: 0,
          overdueGarmentCount: 0,
          overdueOrderCount: 0,
        }),
      }),
    /outside the 30-day window/u,
  );
});

test("owner drilldowns preserve full totals while bounding PII-free rows", () => {
  const rows = Object.freeze(
    Array.from({ length: 51 }, (_, index) =>
      Object.freeze({
        ticketNo: `T-${String(index).padStart(3, "0")}`,
        receivedAt: new Date(`2026-07-0${(index % 7) + 1}T18:30:00.000Z`),
        balanceCents: index + 1,
      }),
    ),
  );
  const result = buildOwnerDrilldownResult({
    businessDate: "2026-08-07",
    generatedAt: "2026-08-07T18:30:00.000Z",
    snapshot: Object.freeze({
      kind: "new_receivables",
      totalRowCount: 51,
      newReceivableCents: rows.reduce((sum, row) => sum + row.balanceCents, 0),
      newReceivableOrderCount: 51,
      rows,
    }),
  });

  assert.equal(result.kind, "new_receivables");
  assert.equal(result.total_row_count, 51);
  assert.equal(result.rows.length, 50);
  assert.equal(result.truncated, true);
  assert.equal(result.totals.new_receivable_order_count, 51);
  assert.equal(result.totals.new_receivable_cents, 1_326);
  assert.ok(result.rows.every((row) => !("customer_phone" in row) && !("order_id" in row)));
});

test("stagnant drilldown derives completed 24-hour age from the shared generated time", () => {
  const result = buildOwnerDrilldownResult({
    businessDate: "2026-08-07",
    generatedAt: "2026-08-07T18:30:00.000Z",
    snapshot: Object.freeze({
      kind: "stagnant_garments",
      totalRowCount: 1,
      overdueGarmentCount: 2,
      overdueOrderCount: 1,
      rows: Object.freeze([
        Object.freeze({
          ticketNo: "T-OLD",
          receivedAt: new Date("2026-07-08T18:30:00.000Z"),
          garmentCount: 2,
          balanceCents: 300,
        }),
      ]),
    }),
  });
  assert.equal(result.kind, "stagnant_garments");
  assert.equal(result.rows[0]?.age_days, 30);
  assert.equal(result.overdue_min_age_days, 30);
});

test("owner portfolio totals only the first 50 returned authorized stores", () => {
  const stores = Object.freeze(
    Array.from({ length: 50 }, (_, index) =>
      Object.freeze({
        store: Object.freeze({
          storeId: `ignored-${index}`,
          storeCode: `s-${String(index).padStart(2, "0")}`,
          storeName: `门店 ${index}`,
          timeZone: "Asia/Shanghai",
        }),
        businessDate: "2026-08-07",
        metrics: Object.freeze({
          performanceIncomeCents: 100,
          realIncomeCents: 80,
          pickedUpGarmentCount: 1,
          newReceivableCents: 20,
          newReceivableOrderCount: 1,
          overdueGarmentCount: 2,
          overdueOrderCount: 1,
        }),
      }),
    ),
  );
  const result = buildOwnerPortfolioResult({
    generatedAt: "2026-08-07T18:30:00.000Z",
    stores,
    truncated: true,
  });
  assert.equal(result.returned_store_count, 50);
  assert.equal(result.truncated, true);
  assert.equal(result.totals.performance_income_cents, 5_000);
  assert.equal(result.totals.overdue_garment_count, 100);
  assert.ok(result.stores.every((store) => !("store_id" in store)));
});
