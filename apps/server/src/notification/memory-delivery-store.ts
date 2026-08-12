import { createHmac, randomBytes } from "node:crypto";

import {
  NotificationDeliveryBatchEnqueueResultSchema,
  NotificationDeliveryBatchGetResultSchema,
  NotificationDeliveryViewSchema,
} from "@laundry/contracts";

import { buildDeliveryBatchSummary } from "./delivery-view.js";
import type {
  NotificationDeliveryEnqueueRequest,
  NotificationDeliveryStore,
  NotificationWorkerStore,
} from "./delivery-types.js";
import {
  createMemoryDeliveryRepository,
  type MemoryBatch,
  type MemoryDelivery,
  type MemoryDeliveryRepository,
  MEMORY_NOTIFICATION_TEMPLATE,
  memoryReminderFilters,
  type MemoryNotificationDeliveryStoreOptions,
} from "./memory-delivery-support.js";
import { createMemoryNotificationWorkerStore } from "./memory-delivery-worker.js";

export type { MemoryNotificationDeliveryStoreOptions } from "./memory-delivery-support.js";

type HandlerContext = Readonly<{
  options: MemoryNotificationDeliveryStoreOptions;
  repository: MemoryDeliveryRepository;
  recipientHmac: (phone: string) => string;
}>;

function deliveriesFor(context: HandlerContext, batch: MemoryBatch) {
  return context.repository.deliveriesFor(batch);
}

function summary(context: HandlerContext, batch: MemoryBatch) {
  return buildDeliveryBatchSummary({
    id: batch.id,
    assurance: batch.assurance,
    providerCode: batch.providerCode,
    templateCode: batch.template.code,
    templateVersion: batch.template.version,
    recipientCount: batch.recipientCount,
    maxCostCents: batch.maxCostCents,
    createdAt: batch.createdAt,
    deliveries: deliveriesFor(context, batch),
  });
}

function memoryBatch(request: NotificationDeliveryEnqueueRequest): MemoryBatch {
  return Object.freeze({
    id: request.batchId,
    orgId: request.tenant.orgId,
    storeId: request.tenant.storeId,
    providerCode: request.providerCode,
    assurance: request.assurance,
    template: request.template,
    filters: memoryReminderFilters(request),
    recipientCount: request.deliveries.length,
    estimatedCostCents: request.estimatedCostCents,
    maxCostCents: request.input.max_cost_cents,
    createdAt: request.createdAt,
  });
}

function memoryDeliveries(
  context: HandlerContext,
  request: NotificationDeliveryEnqueueRequest,
): readonly MemoryDelivery[] {
  return request.deliveries.map((seed) =>
    Object.freeze({
      id: seed.id,
      orgId: request.tenant.orgId,
      storeId: request.tenant.storeId,
      batchId: request.batchId,
      orderId: seed.candidate.order_id,
      customerId: seed.candidate.customer_id,
      status: "queued" as const,
      recipientHmac: context.recipientHmac(seed.candidate.customer_phone),
      messageSha256: seed.messageSha256,
      attemptCount: 0,
      nextAttemptAt: request.createdAt,
      claimedAt: null,
      leaseUntil: null,
      leaseToken: null,
      workerId: null,
      lastErrorCode: null,
      providerRefSha256: null,
      costCents: 0,
      reservedCostCents: 0,
      providerOutcomePending: false,
      acceptedAt: null,
      deliveredAt: null,
      createdAt: request.createdAt,
      updatedAt: request.createdAt,
    }),
  );
}

function enqueueBatch(context: HandlerContext, request: NotificationDeliveryEnqueueRequest) {
  return context.repository.exclusive(async () => {
    const requested = new Set(request.deliveries.map((delivery) => delivery.candidate.order_id));
    if (
      context.repository
        .deliveries()
        .some(
          (delivery) =>
            delivery.orgId === request.tenant.orgId &&
            delivery.storeId === request.tenant.storeId &&
            requested.has(delivery.orderId),
        )
    ) {
      throw new Error("NOTIFICATION_DELIVERY_ACTIVE");
    }
    const batch = memoryBatch(request);
    context.repository.appendBatch(batch, memoryDeliveries(context, request));
    return NotificationDeliveryBatchEnqueueResultSchema.parse({
      batch_id: batch.id,
      status: "queued",
      assurance: batch.assurance,
      provider_code: batch.providerCode,
      channel: "sms",
      template_code: batch.template.code,
      template_version: batch.template.version,
      recipient_count: batch.recipientCount,
      order_count: batch.recipientCount,
      estimated_cost_cents: batch.estimatedCostCents,
      max_cost_cents: batch.maxCostCents,
      created_at: batch.createdAt.toISOString(),
    });
  });
}

async function deliveryView(
  context: HandlerContext,
  orgId: string,
  storeId: string,
  delivery: MemoryDelivery,
) {
  const order = await context.options.orderStore.getOrder(orgId, storeId, delivery.orderId);
  if (order?.ticket_no === null || order?.ticket_no === undefined) return null;
  return NotificationDeliveryViewSchema.parse({
    delivery_id: delivery.id,
    order_id: delivery.orderId,
    ticket_no: order.ticket_no,
    status: delivery.status,
    attempt_count: delivery.attemptCount,
    next_attempt_at: delivery.nextAttemptAt?.toISOString() ?? null,
    last_error_code: delivery.lastErrorCode,
    cost_cents: delivery.costCents,
    updated_at: delivery.updatedAt.toISOString(),
  });
}

function createHandlerStore(context: HandlerContext): NotificationDeliveryStore {
  return Object.freeze({
    getActiveTemplate: async (_client, _tenant, code) =>
      code === MEMORY_NOTIFICATION_TEMPLATE.code ? MEMORY_NOTIFICATION_TEMPLATE : null,
    assertOrdersAvailable: async (_client, tenant, orderIds) => {
      const requested = new Set(orderIds);
      return !context.repository
        .deliveries()
        .some(
          (delivery) =>
            delivery.orgId === tenant.orgId &&
            delivery.storeId === tenant.storeId &&
            requested.has(delivery.orderId),
        );
    },
    enqueueBatch: (request) => enqueueBatch(context, request),
    listBatches: async (_client, tenant, limit) =>
      context.repository
        .batches()
        .filter((batch) => batch.orgId === tenant.orgId && batch.storeId === tenant.storeId)
        .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
        .slice(0, limit)
        .map((batch) => summary(context, batch)),
    getBatch: async (_client, tenant, batchId) => {
      const batch = context.repository
        .batches()
        .find(
          (candidate) =>
            candidate.orgId === tenant.orgId &&
            candidate.storeId === tenant.storeId &&
            candidate.id === batchId,
        );
      if (batch === undefined) return null;
      const deliveries = await Promise.all(
        deliveriesFor(context, batch).map((delivery) =>
          deliveryView(context, tenant.orgId, tenant.storeId, delivery),
        ),
      );
      if (deliveries.some((delivery) => delivery === null)) return null;
      return NotificationDeliveryBatchGetResultSchema.parse({
        batch: summary(context, batch),
        deliveries,
      });
    },
  });
}

export function createMemoryNotificationDeliveryStore(
  options: MemoryNotificationDeliveryStoreOptions,
): NotificationDeliveryStore & NotificationWorkerStore {
  const key = Buffer.from(options.hmacKey ?? randomBytes(32));
  const repository = createMemoryDeliveryRepository();
  const context = Object.freeze({
    options,
    repository,
    recipientHmac: (phone: string): string =>
      createHmac("sha256", key).update(phone, "utf8").digest("hex"),
  });
  return Object.freeze({
    ...createHandlerStore(context),
    ...createMemoryNotificationWorkerStore(context),
  });
}
