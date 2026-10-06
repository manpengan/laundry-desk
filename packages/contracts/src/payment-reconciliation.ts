import { z } from "zod";
import { ChannelReconcileViewSchema } from "./payment-channel.js";

const DateSchema = z.iso.date();
const ChannelSchema = z.enum(["wechat", "alipay"]);
export const ReconciliationHistoryInputSchema = z
  .strictObject({
    channel: ChannelSchema.optional(),
    date_from: DateSchema.optional(),
    date_to: DateSchema.optional(),
    offset: z.number().int().min(0).max(10000).default(0),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .refine((input) => !input.date_from || !input.date_to || input.date_from <= input.date_to);
export const ReconciliationSummarySchema = z.strictObject({
  reconciliation_id: z.uuid(),
  channel: ChannelSchema,
  business_date: DateSchema,
  created_at: z.iso.datetime(),
  source_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  matched_count: z.number().int().nonnegative(),
  mismatch_count: z.number().int().min(0).max(10000),
});
export const ReconciliationHistoryViewSchema = z.strictObject({
  rows: z.array(ReconciliationSummarySchema).max(100),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100),
});
export const ReconciliationDetailInputSchema = z.strictObject({
  reconciliation_id: z.uuid(),
  offset: z.number().int().min(0).max(10000).default(0),
  limit: z.number().int().min(1).max(100).default(50),
});
export const ReconciliationReviewSchema = z.strictObject({
  state: z.enum(["open", "investigating", "resolved"]),
  note: z.string().max(1000),
  version: z.number().int().nonnegative(),
  reviewed_at: z.iso.datetime().nullable(),
});
export const ReconciliationDifferenceSchema =
  ChannelReconcileViewSchema.shape.mismatches.element.extend({
    index: z.number().int().min(0).max(9999),
    order_id: z.uuid().nullable(),
    review: ReconciliationReviewSchema,
  });
export const ReconciliationDetailViewSchema = z.strictObject({
  summary: ReconciliationSummarySchema,
  rows: z.array(ReconciliationDifferenceSchema).max(100),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100),
});
export const ReconciliationReviewInputSchema = z.strictObject({
  reconciliation_id: z.uuid(),
  index: z.number().int().min(0).max(9999),
  state: z.enum(["open", "investigating", "resolved"]),
  note: z.string().trim().min(1).max(1000),
  expected_version: z.number().int().nonnegative(),
});
export const ReconciliationReviewViewSchema = z.strictObject({
  reconciliation_id: z.uuid(),
  index: z.number().int().min(0).max(9999),
  review: ReconciliationReviewSchema,
});
export type ReconciliationHistoryInput = z.input<typeof ReconciliationHistoryInputSchema>;
export type ReconciliationHistory = z.infer<typeof ReconciliationHistoryViewSchema>;
export type ReconciliationDetailInput = z.input<typeof ReconciliationDetailInputSchema>;
export type ReconciliationDetail = z.infer<typeof ReconciliationDetailViewSchema>;
export type ReconciliationDifference = z.infer<typeof ReconciliationDifferenceSchema>;
export type ReconciliationReviewInput = z.infer<typeof ReconciliationReviewInputSchema>;
