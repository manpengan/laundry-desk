import { z } from "zod";

import { ExactUtcTimestampSchema } from "../edge/primitives.js";
import { defineQuery, type QueryDefinition } from "../registry/definitions.js";
import { NonNegativeSafeIntegerSchema, OwnerCardMetricsSchema } from "./reporting-owner-shared.js";
import { BusinessDateSchema } from "./stats.js";

const OWNER_RESULT_ROWS = 50;
const TicketNumberSchema = z.string().min(1).max(64);

export const OwnerDashboardDrilldownKindSchema = z.enum([
  "today_pickups",
  "new_receivables",
  "stagnant_garments",
]);

export const OwnerDashboardDrilldownInputSchema = z.strictObject({
  kind: OwnerDashboardDrilldownKindSchema,
});

export const OwnerTodayPickupRowSchema = z.strictObject({
  ticket_no: TicketNumberSchema,
  picked_at: ExactUtcTimestampSchema,
  garment_count: NonNegativeSafeIntegerSchema.positive(),
});

export const OwnerNewReceivableRowSchema = z.strictObject({
  ticket_no: TicketNumberSchema,
  received_at: ExactUtcTimestampSchema,
  balance_cents: NonNegativeSafeIntegerSchema.positive(),
});

export const OwnerStagnantGarmentRowSchema = z.strictObject({
  ticket_no: TicketNumberSchema,
  received_at: ExactUtcTimestampSchema,
  age_days: NonNegativeSafeIntegerSchema.min(30),
  garment_count: NonNegativeSafeIntegerSchema.positive(),
  balance_cents: NonNegativeSafeIntegerSchema,
});

const DrilldownCommonShape = {
  business_date: BusinessDateSchema,
  generated_at: ExactUtcTimestampSchema,
  total_row_count: NonNegativeSafeIntegerSchema,
  truncated: z.boolean(),
} as const;

const OwnerTodayPickupsResultSchema = z.strictObject({
  ...DrilldownCommonShape,
  kind: z.literal("today_pickups"),
  totals: z.strictObject({
    picked_up_garment_count: NonNegativeSafeIntegerSchema,
    picked_up_order_count: NonNegativeSafeIntegerSchema,
  }),
  rows: z.array(OwnerTodayPickupRowSchema).max(OWNER_RESULT_ROWS),
});

const OwnerNewReceivablesResultSchema = z.strictObject({
  ...DrilldownCommonShape,
  kind: z.literal("new_receivables"),
  totals: z.strictObject({
    new_receivable_cents: NonNegativeSafeIntegerSchema,
    new_receivable_order_count: NonNegativeSafeIntegerSchema,
  }),
  rows: z.array(OwnerNewReceivableRowSchema).max(OWNER_RESULT_ROWS),
});

const OwnerStagnantGarmentsResultSchema = z.strictObject({
  ...DrilldownCommonShape,
  kind: z.literal("stagnant_garments"),
  overdue_min_age_days: z.literal(30),
  totals: z.strictObject({
    overdue_garment_count: NonNegativeSafeIntegerSchema,
    overdue_order_count: NonNegativeSafeIntegerSchema,
  }),
  rows: z.array(OwnerStagnantGarmentRowSchema).max(OWNER_RESULT_ROWS),
});

type DrilldownResult =
  | z.output<typeof OwnerTodayPickupsResultSchema>
  | z.output<typeof OwnerNewReceivablesResultSchema>
  | z.output<typeof OwnerStagnantGarmentsResultSchema>;

function rowMeasure(value: DrilldownResult): bigint {
  if (value.kind === "today_pickups") {
    return value.rows.reduce((sum, row) => sum + BigInt(row.garment_count), 0n);
  }
  if (value.kind === "new_receivables") {
    return value.rows.reduce((sum, row) => sum + BigInt(row.balance_cents), 0n);
  }
  return value.rows.reduce((sum, row) => sum + BigInt(row.garment_count), 0n);
}

function totalMeasure(value: DrilldownResult): bigint {
  if (value.kind === "today_pickups") return BigInt(value.totals.picked_up_garment_count);
  if (value.kind === "new_receivables") return BigInt(value.totals.new_receivable_cents);
  return BigInt(value.totals.overdue_garment_count);
}

function expectedOrderCount(value: DrilldownResult): number | null {
  if (value.kind === "today_pickups") return value.totals.picked_up_order_count;
  if (value.kind === "new_receivables") return value.totals.new_receivable_order_count;
  if (value.kind === "stagnant_garments") return value.totals.overdue_order_count;
  return null;
}

export const OwnerDashboardDrilldownResultSchema = z
  .discriminatedUnion("kind", [
    OwnerTodayPickupsResultSchema,
    OwnerNewReceivablesResultSchema,
    OwnerStagnantGarmentsResultSchema,
  ])
  .superRefine((value, context) => {
    if (value.total_row_count < value.rows.length) {
      context.addIssue({ code: "custom", path: ["total_row_count"], message: "invalid total" });
    }
    if (value.truncated !== value.total_row_count > value.rows.length) {
      context.addIssue({ code: "custom", path: ["truncated"], message: "invalid truncation" });
    }
    if (value.truncated && value.rows.length !== OWNER_RESULT_ROWS) {
      context.addIssue({ code: "custom", path: ["rows"], message: "invalid truncated rows" });
    }
    const orderCount = expectedOrderCount(value);
    if (orderCount !== null && orderCount !== value.total_row_count) {
      context.addIssue({ code: "custom", path: ["totals"], message: "invalid order total" });
    }
    const returnedMeasure = rowMeasure(value);
    const fullMeasure = totalMeasure(value);
    if (returnedMeasure > fullMeasure || (!value.truncated && returnedMeasure !== fullMeasure)) {
      context.addIssue({ code: "custom", path: ["totals"], message: "invalid row totals" });
    }
    if (new Set(value.rows.map((row) => row.ticket_no)).size !== value.rows.length) {
      context.addIssue({ code: "custom", path: ["rows"], message: "duplicate ticket" });
    }
  });

export const OwnerPortfolioInputSchema = z.strictObject({});

export const OwnerPortfolioStoreSchema = OwnerCardMetricsSchema.extend({
  store_code: z.string().min(1).max(64),
  store_name: z.string().min(1).max(128),
  timezone: z.string().min(1).max(64),
  business_date: BusinessDateSchema,
}).strict();

export const OwnerPortfolioTotalsSchema = OwnerCardMetricsSchema;

const OWNER_METRIC_KEYS = [
  "performance_income_cents",
  "real_income_cents",
  "picked_up_garment_count",
  "new_receivable_cents",
  "new_receivable_order_count",
  "overdue_garment_count",
  "overdue_order_count",
] as const;

export const OwnerPortfolioResultSchema = z
  .strictObject({
    generated_at: ExactUtcTimestampSchema,
    returned_store_count: NonNegativeSafeIntegerSchema.max(OWNER_RESULT_ROWS),
    truncated: z.boolean(),
    totals: OwnerPortfolioTotalsSchema,
    stores: z.array(OwnerPortfolioStoreSchema).max(OWNER_RESULT_ROWS),
  })
  .superRefine((value, context) => {
    if (value.returned_store_count !== value.stores.length) {
      context.addIssue({
        code: "custom",
        path: ["returned_store_count"],
        message: "invalid count",
      });
    }
    if (value.truncated && value.stores.length !== OWNER_RESULT_ROWS) {
      context.addIssue({ code: "custom", path: ["truncated"], message: "invalid truncation" });
    }
    const codes = value.stores.map((store) => store.store_code);
    if (
      new Set(codes).size !== codes.length ||
      codes.some((code, index) => index > 0 && code < codes[index - 1]!)
    ) {
      context.addIssue({
        code: "custom",
        path: ["stores"],
        message: "stores must be unique and sorted",
      });
    }
    for (const key of OWNER_METRIC_KEYS) {
      const sum = value.stores.reduce((total, store) => total + BigInt(store[key]), 0n);
      if (sum !== BigInt(value.totals[key])) {
        context.addIssue({
          code: "custom",
          path: ["totals", key],
          message: "invalid portfolio total",
        });
      }
    }
  });

export const reportingOwnerDashboardDrilldownQuery: QueryDefinition<
  typeof OwnerDashboardDrilldownInputSchema
> = defineQuery({
  name: "reporting.owner_dashboard.drilldown",
  version: "0.1.0",
  description: "Read one fixed, server-scoped owner dashboard drilldown with at most 50 rows.",
  description_llm: "Owner-only operational detail. This query is not projected to AI tools.",
  input: OwnerDashboardDrilldownInputSchema,
  risk: "R1",
  invariants: ["rbac.accounting_read"],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  max_result_rows: OWNER_RESULT_ROWS,
});

export const reportingOwnerPortfolioGetQuery: QueryDefinition<typeof OwnerPortfolioInputSchema> =
  defineQuery({
    name: "reporting.owner_portfolio.get",
    version: "0.1.0",
    description: "Compare ADR-26 owner cards across at most 50 stores where the actor is admin.",
    description_llm: "Owner-only multi-store comparison. This query is not projected to AI tools.",
    input: OwnerPortfolioInputSchema,
    risk: "R1",
    invariants: ["rbac.accounting_read"],
    idempotent: true,
    sideEffects: [],
    offline_mode: "denied",
    data_classification: "internal",
    input_redaction: [],
    result_redaction: [],
    max_result_rows: OWNER_RESULT_ROWS,
  });

export type OwnerDashboardDrilldownInput = z.output<typeof OwnerDashboardDrilldownInputSchema>;
export type OwnerDashboardDrilldownResult = z.output<typeof OwnerDashboardDrilldownResultSchema>;
export type OwnerDashboardDrilldownKind = z.output<typeof OwnerDashboardDrilldownKindSchema>;
export type OwnerTodayPickupRow = z.output<typeof OwnerTodayPickupRowSchema>;
export type OwnerNewReceivableRow = z.output<typeof OwnerNewReceivableRowSchema>;
export type OwnerStagnantGarmentRow = z.output<typeof OwnerStagnantGarmentRowSchema>;
export type OwnerPortfolioResult = z.output<typeof OwnerPortfolioResultSchema>;
export type OwnerPortfolioStore = z.output<typeof OwnerPortfolioStoreSchema>;
