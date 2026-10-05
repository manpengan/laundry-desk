import { z } from "zod";
import { CommandResponseSchema } from "../envelope/responses.js";
import {
  PaymentChannelSettingsRequestSchema,
  PaymentChannelSettingsViewSchema,
  ChannelCheckoutInputSchema,
  ChannelIntentIdSchema,
  ChannelIntentViewSchema,
  ChannelIntentsViewSchema,
  ChannelListInputSchema,
  ChannelRefundIdSchema,
  ChannelRefundViewSchema,
  ChannelRefundsViewSchema,
  ChannelRefundInputSchema,
  ChannelReconcileInputSchema,
  ChannelReconcileViewSchema,
  ChannelAvailabilityViewSchema,
  ChannelResolveInputSchema,
} from "../payment-channel.js";

import {
  ReconciliationHistoryInputSchema,
  ReconciliationHistoryViewSchema,
  ReconciliationDetailInputSchema,
  ReconciliationDetailViewSchema,
  ReconciliationReviewInputSchema,
  ReconciliationReviewViewSchema,
} from "../payment-reconciliation.js";

export const DesktopPaymentChannelInputSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("settings.get") }),
  z.strictObject({ operation: z.literal("available") }),
  z.strictObject({
    operation: z.literal("settings.save"),
    body: PaymentChannelSettingsRequestSchema,
  }),
  z.strictObject({ operation: z.literal("checkout"), body: ChannelCheckoutInputSchema }),
  z.strictObject({ operation: z.literal("status"), body: ChannelIntentIdSchema }),
  z.strictObject({ operation: z.literal("close"), body: ChannelIntentIdSchema }),
  z.strictObject({ operation: z.literal("list"), body: ChannelListInputSchema }),
  z.strictObject({ operation: z.literal("refunds.list"), body: ChannelListInputSchema }),
  z.strictObject({ operation: z.literal("refunds.status"), body: ChannelRefundIdSchema }),
  z.strictObject({ operation: z.literal("reconcile"), body: ChannelReconcileInputSchema }),
  z.strictObject({ operation: z.literal("resolve"), body: ChannelResolveInputSchema }),
  z.strictObject({
    operation: z.literal("reconcile.history"),
    body: ReconciliationHistoryInputSchema,
  }),
  z.strictObject({
    operation: z.literal("reconcile.detail"),
    body: ReconciliationDetailInputSchema,
  }),
  z.strictObject({
    operation: z.literal("reconcile.review"),
    body: ReconciliationReviewInputSchema,
  }),
]);
export const PaymentChannelDataSchemas = Object.freeze({
  "settings.get": PaymentChannelSettingsViewSchema,
  "settings.save": PaymentChannelSettingsViewSchema,
  available: ChannelAvailabilityViewSchema,
  checkout: ChannelIntentViewSchema,
  status: ChannelIntentViewSchema,
  close: ChannelIntentViewSchema,
  list: ChannelIntentsViewSchema,
  "refunds.list": ChannelRefundsViewSchema,
  "refunds.status": ChannelRefundViewSchema,
  reconcile: ChannelReconcileViewSchema,
  resolve: ChannelIntentViewSchema,
  "reconcile.history": ReconciliationHistoryViewSchema,
  "reconcile.detail": ReconciliationDetailViewSchema,
  "reconcile.review": ReconciliationReviewViewSchema,
});
export const DesktopPaymentChannelResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    data: z.union([
      PaymentChannelSettingsViewSchema,
      ChannelIntentViewSchema,
      ChannelIntentsViewSchema,
      ChannelRefundViewSchema,
      ChannelRefundsViewSchema,
      ChannelRefundInputSchema,
      ChannelReconcileViewSchema,
      ChannelAvailabilityViewSchema,
      ReconciliationHistoryViewSchema,
      ReconciliationDetailViewSchema,
      ReconciliationReviewViewSchema,
    ]),
  }),
  CommandResponseSchema.options[1],
]);
const paths = Object.freeze({
  "settings.get": "settings",
  "settings.save": "settings",
  checkout: "checkout",
  status: "status",
  close: "close",
  list: "list",
  "refunds.list": "refunds/list",
  "refunds.status": "refunds/status",
  reconcile: "reconcile",
  available: "available",
  resolve: "resolve",
  "reconcile.history": "reconcile/history",
  "reconcile.detail": "reconcile/detail",
  "reconcile.review": "reconcile/review",
});
export function paymentChannelRoute(input: DesktopPaymentChannelInput) {
  return Object.freeze({
    method:
      input.operation === "settings.get" || input.operation === "available"
        ? ("GET" as const)
        : ("POST" as const),
    path: `/api/v2/payment-channels/${paths[input.operation]}`,
  });
}
export type DesktopPaymentChannelInput = z.infer<typeof DesktopPaymentChannelInputSchema>;
export type PaymentChannelSettings = z.infer<typeof PaymentChannelSettingsViewSchema>;
export type PaymentChannelSettingsRequest = z.infer<typeof PaymentChannelSettingsRequestSchema>;
export type ChannelIntent = z.infer<typeof ChannelIntentViewSchema>;
export type ChannelRefund = z.infer<typeof ChannelRefundViewSchema>;
export type ChannelReconciliation = z.infer<typeof ChannelReconcileViewSchema>;
export type ChannelReconcileInput = z.infer<typeof ChannelReconcileInputSchema>;
export type ChannelRefundInput = z.infer<typeof ChannelRefundInputSchema>;

/** A valid envelope must also identify the operation's requested payment. */
export function paymentChannelResultMatches(
  input: DesktopPaymentChannelInput,
  raw: unknown,
): boolean {
  const parsed = PaymentChannelDataSchemas[input.operation].safeParse(raw);
  if (!parsed.success) return false;
  const data = parsed.data;
  if (input.operation === "checkout")
    return (
      "intent_id" in data &&
      "order_id" in data &&
      data.order_id === input.body.order_id &&
      data.channel === input.body.channel &&
      data.purpose === "order"
    );
  if (input.operation === "status" || input.operation === "close" || input.operation === "resolve")
    return "intent_id" in data && data.intent_id === input.body.intent_id;
  if (input.operation === "refunds.status")
    return "refund_id" in data && data.refund_id === input.body.refund_id;
  if (input.operation === "list" && input.body.order_id)
    return (
      "intents" in data && data.intents.every((intent) => intent.order_id === input.body.order_id)
    );
  if (input.operation === "reconcile.detail")
    return "summary" in data && data.summary.reconciliation_id === input.body.reconciliation_id;
  if (input.operation === "reconcile.review")
    return (
      "review" in data &&
      "reconciliation_id" in data &&
      data.reconciliation_id === input.body.reconciliation_id &&
      data.index === input.body.index
    );
  if (input.operation === "reconcile.history" && input.body.channel)
    return (
      "rows" in data &&
      data.rows.every((row) => "channel" in row && row.channel === input.body.channel)
    );
  return true;
}
