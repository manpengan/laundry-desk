import assert from "node:assert/strict";
import test from "node:test";

import { aggregateAccountingReport, type AccountingMovement } from "@laundry/domain";

import { buildOwnerDashboardResult } from "./model.js";

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
