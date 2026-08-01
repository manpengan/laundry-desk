import { z } from "zod";

import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";
import { ExactUtcTimestampSchema } from "../edge/primitives.js";
import { BusinessDateSchema } from "./stats.js";

const NonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const SafeIntegerSchema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);

export const ReconciliationDayGetInputSchema = z.strictObject({
  /** Omit to let the server derive the store's current business day. */
  business_date: BusinessDateSchema.optional(),
});

export const ReconciliationExportInputSchema = z.strictObject({
  /** Omit to let the server derive the store's current business day. */
  business_date: BusinessDateSchema.optional(),
  format: z.literal("csv"),
});

// ADR-18: stored-value settlement gets its own bucket row so cash-in and
// balance-burn never merge into one unreadable number.
export const ReconciliationPaymentMethodSchema = z.enum([
  "cash",
  "wechat",
  "alipay",
  "other",
  "balance",
]);
export const ReconciliationPaymentKindSchema = z.enum([
  "pay",
  "repay",
  "refund",
  "storage_fee",
  "reversal",
]);
export const ReconciliationPrintStatusSchema = z.enum(["queued", "printing", "done", "failed"]);
export const ReconciliationReplayDecisionSchema = z.enum([
  "applied",
  "duplicate",
  "arbitration",
  "collision",
  "rejected",
]);

export const ReconciliationDayResultSchema = z.strictObject({
  business_date: BusinessDateSchema,
  generated_at: ExactUtcTimestampSchema,
  orders: z.strictObject({
    count: NonNegativeSafeIntegerSchema,
    payable_cents: NonNegativeSafeIntegerSchema,
    paid_cents: NonNegativeSafeIntegerSchema,
    balance_cents: NonNegativeSafeIntegerSchema,
  }),
  ledger: z.strictObject({
    row_count: NonNegativeSafeIntegerSchema,
    gross_cents: NonNegativeSafeIntegerSchema,
    refund_cents: NonNegativeSafeIntegerSchema,
    net_cents: SafeIntegerSchema,
    difference_from_orders_cents: SafeIntegerSchema,
    buckets: z
      .array(
        z.strictObject({
          method: ReconciliationPaymentMethodSchema,
          kind: ReconciliationPaymentKindSchema,
          row_count: NonNegativeSafeIntegerSchema,
          amount_cents: NonNegativeSafeIntegerSchema,
          net_cents: SafeIntegerSchema,
        }),
      )
      // 5 methods x 5 kinds. The previous 20 was exactly 4 x 5, so adding a
      // method without raising this would reject a legitimate day.
      .max(25)
      .refine(
        (buckets) =>
          new Set(buckets.map((bucket) => `${bucket.method}:${bucket.kind}`)).size ===
          buckets.length,
        { message: "Payment buckets must be unique by method and kind" },
      ),
  }),
  shift: z
    .strictObject({
      closed_at: ExactUtcTimestampSchema,
      order_count: NonNegativeSafeIntegerSchema,
      payable_cents: NonNegativeSafeIntegerSchema,
      paid_cents: NonNegativeSafeIntegerSchema,
      payment_cents: NonNegativeSafeIntegerSchema,
      counted_cash_cents: NonNegativeSafeIntegerSchema,
      retained_float_cents: NonNegativeSafeIntegerSchema,
      expected_cash_cents: NonNegativeSafeIntegerSchema,
      cash_difference_cents: SafeIntegerSchema,
    })
    .nullable(),
  print: z.strictObject({
    total: NonNegativeSafeIntegerSchema,
    statuses: z
      .array(
        z.strictObject({
          status: ReconciliationPrintStatusSchema,
          count: NonNegativeSafeIntegerSchema,
        }),
      )
      .max(4)
      .refine(
        (statuses) => new Set(statuses.map((status) => status.status)).size === statuses.length,
        { message: "Print status counts must be unique" },
      ),
  }),
  edge_replay: z.strictObject({
    total: NonNegativeSafeIntegerSchema,
    conflict_count: NonNegativeSafeIntegerSchema,
    decisions: z
      .array(
        z.strictObject({
          decision: ReconciliationReplayDecisionSchema,
          count: NonNegativeSafeIntegerSchema,
        }),
      )
      .max(5)
      .refine(
        (decisions) =>
          new Set(decisions.map((decision) => decision.decision)).size === decisions.length,
        { message: "Replay decision counts must be unique" },
      ),
  }),
});

export const ReconciliationExportResultSchema = z.strictObject({
  filename: z.string().regex(/^reconciliation-\d{4}-\d{2}-\d{2}\.csv$/u),
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  csv: z
    .string()
    .min(1)
    .refine((value) => new TextEncoder().encode(value).byteLength <= 1_048_576, {
      message: "CSV must not exceed 1 MiB",
    }),
});

type DayInput = typeof ReconciliationDayGetInputSchema;
type ExportInput = typeof ReconciliationExportInputSchema;

export const reconciliationDayGetQuery: QueryDefinition<DayInput> = defineQuery({
  name: "reconciliation.day.get",
  version: "0.1.0",
  description:
    "Load one bounded, redacted business-day reconciliation summary; omit business_date for the server-derived current day.",
  description_llm:
    "Return current cumulative totals for orders opened on the requested day alongside ledger activity recorded on that day, shift closing, print status and Edge replay decisions. difference_from_orders_cents is diagnostic and may reflect legitimate cross-day repayment, refund or reversal activity. No customer, note, error or raw payload fields.",
  input: ReconciliationDayGetInputSchema,
  risk: "R2",
  invariants: ["rbac.accounting_read"],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  max_result_rows: 29,
});

export const reconciliationExportCommand: CommandDefinition<ExportInput> = defineCommand({
  name: "reconciliation.export",
  version: "0.1.0",
  description:
    "Generate an audited, deterministic CSV for one business day; omit business_date for the server-derived current day.",
  description_llm:
    "Generate a deterministic UTF-8 CSV with formula-injection protection and a SHA-256 digest. The command audit records the export without storing raw CSV.",
  input: ReconciliationExportInputSchema,
  risk: "R3",
  invariants: ["rbac.accounting_read", "rbac.ledger_export"],
  idempotent: true,
  sideEffects: ["reconciliation.exported", "audit.reconciliation_export"],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
});

export const RECONCILIATION_COMMANDS = Object.freeze([reconciliationExportCommand] as const);
export const RECONCILIATION_QUERIES = Object.freeze([reconciliationDayGetQuery] as const);

export type ReconciliationDayResult = z.output<typeof ReconciliationDayResultSchema>;
export type ReconciliationExportResult = z.output<typeof ReconciliationExportResultSchema>;
