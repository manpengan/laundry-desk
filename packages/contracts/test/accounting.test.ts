import { describe, expect, it } from "vitest";

import {
  AccountingReportExportInputSchema,
  AccountingReportInputSchema,
  AccountingReportResultSchema,
  accountingReportExportCommand,
  accountingReportGetQuery,
} from "../src/commands/accounting.js";

const STAFF_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("ADR-24 accounting contracts", () => {
  it("accepts a bounded range and server-derived current day", () => {
    expect(AccountingReportInputSchema.parse({})).toEqual({});
    expect(
      AccountingReportInputSchema.parse({
        date_from: "2026-01-01",
        date_to: "2026-12-31",
        group_by: "staff",
        staff_id: STAFF_ID,
      }),
    ).toMatchObject({ group_by: "staff", staff_id: STAFF_ID });
  });

  it("rejects partial, reversed and overlong date ranges", () => {
    expect(() => AccountingReportInputSchema.parse({ date_from: "2026-01-01" })).toThrow();
    expect(() =>
      AccountingReportInputSchema.parse({
        date_from: "2026-02-01",
        date_to: "2026-01-01",
      }),
    ).toThrow();
    expect(() =>
      AccountingReportInputSchema.parse({
        date_from: "2025-01-01",
        date_to: "2026-01-02",
      }),
    ).toThrow(/366/u);
  });

  it("freezes a read-only R2 query and an audited R3 export", () => {
    expect(accountingReportGetQuery).toMatchObject({
      risk: "R2",
      offline_mode: "denied",
      max_result_rows: 366,
    });
    expect(accountingReportExportCommand).toMatchObject({
      risk: "R3",
      offline_mode: "denied",
    });
    expect(AccountingReportExportInputSchema.parse({ format: "csv" })).toEqual({ format: "csv" });
  });

  it("validates the five-channel, integer-fen result without tenant input", () => {
    const result = AccountingReportResultSchema.parse({
      date_from: "2026-08-01",
      date_to: "2026-08-01",
      group_by: "day",
      staff_id: null,
      generated_at: "2026-08-07T05:00:00.000Z",
      totals: {
        real_income_cents: 12_000,
        performance_income_cents: 7_000,
        order_cashflow_cents: 5_000,
        stored_value_cashflow_cents: 7_000,
        stored_value_consumption_cents: 2_000,
        ledger_row_count: 3,
      },
      channels: [
        {
          method: "cash",
          order_income_cents: 5_000,
          stored_value_cashflow_cents: 7_000,
          real_income_cents: 12_000,
          performance_income_cents: 5_000,
          ledger_row_count: 2,
        },
        {
          method: "balance",
          order_income_cents: 2_000,
          stored_value_cashflow_cents: 0,
          real_income_cents: 0,
          performance_income_cents: 2_000,
          ledger_row_count: 1,
        },
        {
          method: "wechat",
          order_income_cents: 0,
          stored_value_cashflow_cents: 0,
          real_income_cents: 0,
          performance_income_cents: 0,
          ledger_row_count: 0,
        },
        {
          method: "alipay",
          order_income_cents: 0,
          stored_value_cashflow_cents: 0,
          real_income_cents: 0,
          performance_income_cents: 0,
          ledger_row_count: 0,
        },
        {
          method: "other",
          order_income_cents: 0,
          stored_value_cashflow_cents: 0,
          real_income_cents: 0,
          performance_income_cents: 0,
          ledger_row_count: 0,
        },
      ],
      rows: [
        {
          key: "2026-08-01",
          label: "2026-08-01",
          real_income_cents: 12_000,
          performance_income_cents: 7_000,
          order_cashflow_cents: 5_000,
          stored_value_cashflow_cents: 7_000,
          stored_value_consumption_cents: 2_000,
          ledger_row_count: 3,
        },
      ],
    });
    expect(result.channels.map((row) => row.method)).toEqual([
      "cash",
      "balance",
      "wechat",
      "alipay",
      "other",
    ]);
    expect(() => AccountingReportInputSchema.parse({ store_id: STAFF_ID })).toThrow();
  });
});
