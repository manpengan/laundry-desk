import { z } from "zod";

import { ExactUtcTimestampSchema } from "../edge/primitives.js";
import { defineQuery, type QueryDefinition } from "../registry/definitions.js";
import { BusinessDateSchema } from "./stats.js";

const DAY_MILLISECONDS = 86_400_000;
const NonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const SafeIntegerSchema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);

export const OwnerDashboardInputSchema = z.strictObject({});

export const OwnerDashboardTodaySchema = z.strictObject({
  performance_income_cents: SafeIntegerSchema,
  real_income_cents: SafeIntegerSchema,
  picked_up_garment_count: NonNegativeSafeIntegerSchema,
  new_receivable_cents: NonNegativeSafeIntegerSchema,
  new_receivable_order_count: NonNegativeSafeIntegerSchema,
  overdue_garment_count: NonNegativeSafeIntegerSchema,
  overdue_order_count: NonNegativeSafeIntegerSchema,
});

export const OwnerDashboardTrendPointSchema = z.strictObject({
  business_date: BusinessDateSchema,
  performance_income_cents: SafeIntegerSchema,
  real_income_cents: SafeIntegerSchema,
});

export const OwnerDashboardResultSchema = z
  .strictObject({
    business_date: BusinessDateSchema,
    generated_at: ExactUtcTimestampSchema,
    overdue_min_age_days: z.literal(30),
    today: OwnerDashboardTodaySchema,
    trend: z.array(OwnerDashboardTrendPointSchema).length(30),
  })
  .superRefine((value, context) => {
    value.trend.forEach((row, index) => {
      if (index === 0) return;
      const previous = Date.parse(`${value.trend[index - 1]?.business_date}T00:00:00.000Z`);
      const current = Date.parse(`${row.business_date}T00:00:00.000Z`);
      if (current - previous !== DAY_MILLISECONDS) {
        context.addIssue({
          code: "custom",
          path: ["trend", index, "business_date"],
          message: "owner dashboard trend must contain consecutive business dates",
        });
      }
    });

    const current = value.trend.at(-1);
    if (current?.business_date !== value.business_date) {
      context.addIssue({
        code: "custom",
        path: ["trend", 29, "business_date"],
        message: "owner dashboard trend must end on business_date",
      });
    }
    if (
      current !== undefined &&
      (current.performance_income_cents !== value.today.performance_income_cents ||
        current.real_income_cents !== value.today.real_income_cents)
    ) {
      context.addIssue({
        code: "custom",
        path: ["today"],
        message: "today income must match the final trend point",
      });
    }
  });

type OwnerDashboardInput = typeof OwnerDashboardInputSchema;

export const reportingOwnerDashboardGetQuery: QueryDefinition<OwnerDashboardInput> = defineQuery({
  name: "reporting.owner_dashboard.get",
  version: "0.1.0",
  description:
    "Read the current store owner's four operating cards and a fixed 30-day dual-basis income trend.",
  description_llm:
    "Owner-only operational and accounting dashboard. This query is not projected to AI tools.",
  input: OwnerDashboardInputSchema,
  risk: "R1",
  invariants: ["rbac.accounting_read"],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  max_result_rows: 30,
});

export const REPORTING_QUERIES = Object.freeze([reportingOwnerDashboardGetQuery] as const);
export const REPORTING_QUERY_NAMES = Object.freeze(["reporting.owner_dashboard.get"] as const);

export type OwnerDashboardResult = z.output<typeof OwnerDashboardResultSchema>;
export type OwnerDashboardToday = z.output<typeof OwnerDashboardTodaySchema>;
export type OwnerDashboardTrendPoint = z.output<typeof OwnerDashboardTrendPointSchema>;
