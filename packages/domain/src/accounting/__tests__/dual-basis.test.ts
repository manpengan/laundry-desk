import { describe, expect, it } from "vitest";

import { aggregateAccountingReport, type AccountingMovement } from "../dual-basis.js";

const STAFF_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STAFF_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function movement(value: AccountingMovement): AccountingMovement {
  return Object.freeze(value);
}

const MOVEMENTS = Object.freeze([
  movement({
    source: "order",
    business_date: "2026-08-01",
    staff_id: STAFF_A,
    staff_name: "店员甲",
    method: "cash",
    net_cents: 5_000,
    ledger_row_count: 1,
  }),
  movement({
    source: "stored_value",
    business_date: "2026-08-01",
    staff_id: STAFF_A,
    staff_name: "店员甲",
    method: "cash",
    net_cents: 10_000,
    ledger_row_count: 1,
  }),
  movement({
    source: "order",
    business_date: "2026-08-02",
    staff_id: STAFF_B,
    staff_name: "店员乙",
    method: "balance",
    net_cents: 3_000,
    ledger_row_count: 1,
  }),
  movement({
    source: "stored_value",
    business_date: "2026-08-02",
    staff_id: STAFF_B,
    staff_name: "店员乙",
    method: "wechat",
    net_cents: -2_000,
    ledger_row_count: 1,
  }),
]);

describe("ADR-24 dual-basis accounting", () => {
  it("counts external money and stored-value consumption exactly once", () => {
    const report = aggregateAccountingReport(MOVEMENTS, "day");
    expect(report.totals).toEqual({
      real_income_cents: 13_000,
      performance_income_cents: 8_000,
      order_cashflow_cents: 5_000,
      stored_value_cashflow_cents: 8_000,
      stored_value_consumption_cents: 3_000,
      ledger_row_count: 4,
    });
    expect(report.rows).toHaveLength(2);
    expect(report.channels).toHaveLength(5);
    expect(report.channels.find((row) => row.method === "balance")).toMatchObject({
      real_income_cents: 0,
      performance_income_cents: 3_000,
    });
    expect(report.channels.find((row) => row.method === "other")).toMatchObject({
      real_income_cents: 0,
      performance_income_cents: 0,
      ledger_row_count: 0,
    });
  });

  it("groups by immutable ledger staff attribution", () => {
    const report = aggregateAccountingReport(MOVEMENTS, "staff");
    expect(report.rows).toEqual([
      expect.objectContaining({ key: STAFF_A, label: "店员甲", real_income_cents: 15_000 }),
      expect.objectContaining({
        key: STAFF_B,
        label: "店员乙",
        real_income_cents: -2_000,
        performance_income_cents: 3_000,
      }),
    ]);
  });

  it("rejects fractional money and contradictory staff names", () => {
    expect(() =>
      aggregateAccountingReport([movement({ ...MOVEMENTS[0]!, net_cents: 1.5 })], "day"),
    ).toThrow(/integer/u);
    expect(() =>
      aggregateAccountingReport(
        [MOVEMENTS[0]!, movement({ ...MOVEMENTS[0]!, staff_name: "另一个名字" })],
        "staff",
      ),
    ).toThrow(/staff name/u);
  });
});
