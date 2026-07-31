import { describe, expect, it } from "vitest";

import {
  EdgeConflictDiscardInputSchema,
  QueryMetadataSchema,
  ReconciliationDayGetInputSchema,
  ReconciliationDayResultSchema,
  ReconciliationExportInputSchema,
  ReconciliationExportResultSchema,
  edgeConflictDiscardCommand,
  parseContractInput,
  reconciliationDayGetQuery,
  reconciliationExportCommand,
} from "../src/index.js";

const queueId = "10000000-0000-4000-8000-000000000001";

const emptySummary = Object.freeze({
  business_date: "2026-07-30",
  generated_at: "2026-07-30T12:00:00.000Z",
  orders: Object.freeze({
    count: 0,
    payable_cents: 0,
    paid_cents: 0,
    balance_cents: 0,
  }),
  ledger: Object.freeze({
    row_count: 0,
    gross_cents: 0,
    refund_cents: 0,
    net_cents: 0,
    difference_from_orders_cents: 0,
    buckets: Object.freeze([]),
  }),
  shift: null,
  print: Object.freeze({ total: 0, statuses: Object.freeze([]) }),
  edge_replay: Object.freeze({
    total: 0,
    conflict_count: 0,
    decisions: Object.freeze([]),
  }),
});

describe("reconciliation contracts", () => {
  it("accepts an omitted business date while rejecting renderer-derived extras", async () => {
    await expect(parseContractInput(reconciliationDayGetQuery, {})).resolves.toEqual({});
    await expect(
      parseContractInput(reconciliationDayGetQuery, { business_date: "2026-07-30" }),
    ).resolves.toEqual({ business_date: "2026-07-30" });
    expect(ReconciliationDayGetInputSchema.safeParse({ business_date: "20260730" }).success).toBe(
      false,
    );
    expect(ReconciliationDayGetInputSchema.safeParse({ business_date: "2026-02-30" }).success).toBe(
      false,
    );
    expect(ReconciliationDayGetInputSchema.safeParse({ utc_date: "2026-07-30" }).success).toBe(
      false,
    );
  });

  it("requires CSV format but permits server-derived current business date", async () => {
    await expect(
      parseContractInput(reconciliationExportCommand, { format: "csv" }),
    ).resolves.toEqual({ format: "csv" });
    expect(ReconciliationExportInputSchema.safeParse({}).success).toBe(false);
    expect(
      ReconciliationExportInputSchema.safeParse({ format: "xlsx", business_date: "2026-07-30" })
        .success,
    ).toBe(false);
  });

  it("validates the bounded redacted result and UTF-8 export ceiling", () => {
    expect(ReconciliationDayResultSchema.parse(emptySummary)).toEqual(emptySummary);
    expect(
      ReconciliationDayResultSchema.safeParse({
        ...emptySummary,
        ledger: {
          ...emptySummary.ledger,
          buckets: Array.from({ length: 21 }, () => ({
            method: "cash",
            kind: "pay",
            row_count: 1,
            amount_cents: 1,
            net_cents: 1,
          })),
        },
      }).success,
    ).toBe(false);
    expect(
      ReconciliationDayResultSchema.safeParse({
        ...emptySummary,
        print: {
          total: 2,
          statuses: [
            { status: "done", count: 1 },
            { status: "done", count: 1 },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      ReconciliationDayResultSchema.safeParse({ ...emptySummary, customer_phone: "secret" })
        .success,
    ).toBe(false);
    expect(
      ReconciliationExportResultSchema.safeParse({
        filename: "reconciliation-2026-07-30.csv",
        content_sha256: "a".repeat(64),
        csv: "衣".repeat(349_526),
      }).success,
    ).toBe(false);
  });

  it("binds accounting query RBAC and audited online-only export", () => {
    expect(reconciliationDayGetQuery.invariants).toEqual(["rbac.accounting_read"]);
    expect(reconciliationExportCommand.invariants).toEqual([
      "rbac.accounting_read",
      "rbac.ledger_export",
    ]);
    expect(reconciliationExportCommand.offline_mode).toBe("denied");
    const queryMetadata = Object.fromEntries(
      Object.entries(reconciliationDayGetQuery).filter(([key]) => key !== "input"),
    );
    expect(QueryMetadataSchema.parse(queryMetadata).invariants).toEqual(["rbac.accounting_read"]);
  });

  it("requires an explicit administrator discard decision", async () => {
    const input = {
      queue_id: queueId,
      reason: "operator reconciled conflict",
      confirm: "DISCARD" as const,
    };
    await expect(parseContractInput(edgeConflictDiscardCommand, input)).resolves.toEqual(input);
    expect(EdgeConflictDiscardInputSchema.safeParse({ ...input, reason: "x" }).success).toBe(false);
    expect(EdgeConflictDiscardInputSchema.safeParse({ ...input, confirm: "discard" }).success).toBe(
      false,
    );
    expect(edgeConflictDiscardCommand.invariants).toEqual(["rbac.edge_conflict_resolve"]);
    expect(edgeConflictDiscardCommand.offline_mode).toBe("denied");
  });
});
