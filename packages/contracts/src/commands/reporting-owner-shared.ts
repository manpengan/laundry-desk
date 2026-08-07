import { z } from "zod";

export const NonNegativeSafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const SafeIntegerSchema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);

export const OwnerCardMetricsSchema = z.strictObject({
  performance_income_cents: SafeIntegerSchema,
  real_income_cents: SafeIntegerSchema,
  picked_up_garment_count: NonNegativeSafeIntegerSchema,
  new_receivable_cents: NonNegativeSafeIntegerSchema,
  new_receivable_order_count: NonNegativeSafeIntegerSchema,
  overdue_garment_count: NonNegativeSafeIntegerSchema,
  overdue_order_count: NonNegativeSafeIntegerSchema,
});
