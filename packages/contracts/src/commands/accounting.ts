import { z } from "zod";

import { ExactUtcTimestampSchema } from "../edge/primitives.js";
import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";
import { BusinessDateSchema } from "./stats.js";

const SafeIntegerSchema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const NonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const StaffIdSchema = z.string().uuid();

export const AccountingGroupBySchema = z.enum(["day", "staff"]);
export const AccountingMethodSchema = z.enum(["cash", "wechat", "alipay", "other", "balance"]);

const reportFields = {
  date_from: BusinessDateSchema.optional(),
  date_to: BusinessDateSchema.optional(),
  group_by: AccountingGroupBySchema.optional(),
  staff_id: StaffIdSchema.optional(),
} as const;

function validateRange(
  value: Readonly<{ date_from?: string | undefined; date_to?: string | undefined }>,
  context: z.RefinementCtx,
): void {
  if ((value.date_from === undefined) !== (value.date_to === undefined)) {
    context.addIssue({
      code: "custom",
      path: [value.date_from === undefined ? "date_from" : "date_to"],
      message: "date_from and date_to must be provided together",
    });
    return;
  }
  if (value.date_from === undefined || value.date_to === undefined) return;
  if (value.date_from > value.date_to) {
    context.addIssue({ code: "custom", path: ["date_to"], message: "date range is reversed" });
    return;
  }
  const startedAt = Date.parse(`${value.date_from}T00:00:00.000Z`);
  const endedAt = Date.parse(`${value.date_to}T00:00:00.000Z`);
  const inclusiveDays = Math.floor((endedAt - startedAt) / 86_400_000) + 1;
  if (inclusiveDays > 366) {
    context.addIssue({
      code: "custom",
      path: ["date_to"],
      message: "date range must not exceed 366 days",
    });
  }
}

export const AccountingReportInputSchema = z.strictObject(reportFields).superRefine(validateRange);

export const AccountingReportExportInputSchema = z
  .strictObject({ ...reportFields, format: z.literal("csv") })
  .superRefine(validateRange);

export const AccountingBasisTotalsSchema = z.strictObject({
  real_income_cents: SafeIntegerSchema,
  performance_income_cents: SafeIntegerSchema,
  order_cashflow_cents: SafeIntegerSchema,
  stored_value_cashflow_cents: SafeIntegerSchema,
  stored_value_consumption_cents: SafeIntegerSchema,
  ledger_row_count: NonNegativeSafeIntegerSchema,
});

export const AccountingChannelSchema = z.strictObject({
  method: AccountingMethodSchema,
  order_income_cents: SafeIntegerSchema,
  stored_value_cashflow_cents: SafeIntegerSchema,
  real_income_cents: SafeIntegerSchema,
  performance_income_cents: SafeIntegerSchema,
  ledger_row_count: NonNegativeSafeIntegerSchema,
});

export const AccountingReportRowSchema = AccountingBasisTotalsSchema.extend({
  key: z.string().min(1).max(64),
  label: z.string().min(1).max(128),
});

export const AccountingReportResultSchema = z.strictObject({
  date_from: BusinessDateSchema,
  date_to: BusinessDateSchema,
  group_by: AccountingGroupBySchema,
  staff_id: StaffIdSchema.nullable(),
  generated_at: ExactUtcTimestampSchema,
  totals: AccountingBasisTotalsSchema,
  channels: z
    .array(AccountingChannelSchema)
    .length(5)
    .refine(
      (rows) => new Set(rows.map((row) => row.method)).size === rows.length,
      "accounting channels must be unique",
    ),
  rows: z
    .array(AccountingReportRowSchema)
    .max(366)
    .refine(
      (rows) => new Set(rows.map((row) => row.key)).size === rows.length,
      "accounting row keys must be unique",
    ),
});

export const AccountingReportExportResultSchema = z.strictObject({
  filename: z.string().regex(/^accounting-\d{4}-\d{2}-\d{2}-\d{4}-\d{2}-\d{2}-(day|staff)\.csv$/u),
  content_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  csv: z
    .string()
    .min(1)
    .refine((value) => new TextEncoder().encode(value).byteLength <= 1_048_576, {
      message: "CSV must not exceed 1 MiB",
    }),
});

type ReportInput = typeof AccountingReportInputSchema;
type ExportInput = typeof AccountingReportExportInputSchema;

export const accountingReportGetQuery: QueryDefinition<ReportInput> = defineQuery({
  name: "accounting.report.get",
  version: "0.1.0",
  description: "Read a bounded dual-basis accounting report grouped by business day or staff.",
  description_llm:
    "Return real income and performance income from immutable ledgers. Current AI presets do not project this query.",
  input: AccountingReportInputSchema,
  risk: "R2",
  invariants: ["rbac.accounting_read"],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  max_result_rows: 366,
});

export const accountingReportExportCommand: CommandDefinition<ExportInput> = defineCommand({
  name: "accounting.report.export",
  version: "0.1.0",
  description: "Generate an audited deterministic CSV for one dual-basis accounting report.",
  description_llm:
    "Generate a bounded UTF-8 accounting CSV with spreadsheet hardening and SHA-256 verification.",
  input: AccountingReportExportInputSchema,
  risk: "R3",
  invariants: ["rbac.accounting_read", "rbac.ledger_export"],
  idempotent: true,
  sideEffects: ["accounting.report_exported", "audit.accounting_report_export"],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
});

export const ACCOUNTING_COMMANDS = Object.freeze([accountingReportExportCommand] as const);
export const ACCOUNTING_QUERIES = Object.freeze([accountingReportGetQuery] as const);
export const ACCOUNTING_COMMAND_NAMES = Object.freeze(["accounting.report.export"] as const);
export const ACCOUNTING_QUERY_NAMES = Object.freeze(["accounting.report.get"] as const);
export const ACCOUNTING_DEFINITIONS: readonly (
  CommandDefinition<z.ZodObject> | QueryDefinition<z.ZodObject>
)[] = Object.freeze([...ACCOUNTING_COMMANDS, ...ACCOUNTING_QUERIES]);

export type AccountingGroupBy = z.output<typeof AccountingGroupBySchema>;
export type AccountingMethod = z.output<typeof AccountingMethodSchema>;
export type AccountingBasisTotals = z.output<typeof AccountingBasisTotalsSchema>;
export type AccountingChannel = z.output<typeof AccountingChannelSchema>;
export type AccountingReportRow = z.output<typeof AccountingReportRowSchema>;
export type AccountingReportResult = z.output<typeof AccountingReportResultSchema>;
export type AccountingReportExportResult = z.output<typeof AccountingReportExportResultSchema>;
