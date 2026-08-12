import {
  NotificationDeliveryBatchSummarySchema,
  type NotificationDeliveryBatchSummary,
  type NotificationDeliveryStatus,
} from "@laundry/contracts";

export type DeliveryCountSource = Readonly<{
  status: NotificationDeliveryStatus;
  costCents: number;
  updatedAt: Date;
}>;

export type BatchSummarySource = Readonly<{
  id: string;
  assurance: "software_only" | "external";
  providerCode: string;
  templateCode: "pickup_reminder_v1";
  templateVersion: number;
  recipientCount: number;
  maxCostCents: number;
  createdAt: Date;
  deliveries: readonly DeliveryCountSource[];
}>;

const DELIVERY_STATUSES = Object.freeze([
  "queued",
  "sending",
  "retry_wait",
  "accepted",
  "delivered",
  "manual_required",
  "cancelled",
] as const satisfies readonly NotificationDeliveryStatus[]);

function batchStatus(counts: Record<NotificationDeliveryStatus, number>, total: number) {
  if (counts.cancelled === total) return "cancelled" as const;
  if (counts.manual_required > 0) return "attention_required" as const;
  if (counts.delivered + counts.cancelled === total) return "completed" as const;
  if (counts.sending + counts.retry_wait + counts.accepted > 0) return "processing" as const;
  return "queued" as const;
}

export function buildDeliveryBatchSummary(
  source: BatchSummarySource,
): NotificationDeliveryBatchSummary {
  const counts = Object.fromEntries(
    DELIVERY_STATUSES.map((status) => [
      status,
      source.deliveries.filter((delivery) => delivery.status === status).length,
    ]),
  ) as Record<NotificationDeliveryStatus, number>;
  const spent = source.deliveries.reduce((total, delivery) => total + delivery.costCents, 0);
  const updatedAt = source.deliveries.reduce(
    (latest, delivery) =>
      delivery.updatedAt.getTime() > latest.getTime() ? delivery.updatedAt : latest,
    source.createdAt,
  );
  return NotificationDeliveryBatchSummarySchema.parse({
    batch_id: source.id,
    status: batchStatus(counts, source.recipientCount),
    assurance: source.assurance,
    provider_code: source.providerCode,
    channel: "sms",
    template_code: source.templateCode,
    template_version: source.templateVersion,
    recipient_count: source.recipientCount,
    counts,
    spent_cost_cents: spent,
    max_cost_cents: source.maxCostCents,
    created_at: source.createdAt.toISOString(),
    updated_at: updatedAt.toISOString(),
  });
}
