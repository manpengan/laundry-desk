import {
  NotificationDeliveryBatchEnqueueResultSchema,
  NotificationDeliveryBatchGetResultSchema,
  NotificationDeliveryViewSchema,
  type NotificationDeliveryBatchSummary,
  type NotificationDeliveryStatus,
} from "@laundry/contracts";

import { buildDeliveryBatchSummary } from "./delivery-view.js";
import type {
  NotificationDeliveryEnqueueRequest,
  NotificationDeliveryStore,
  NotificationTemplateSnapshot,
} from "./delivery-types.js";

type TemplateRow = Readonly<{
  id: string;
  code: "pickup_reminder_v1";
  version: number;
  channel: "sms";
  body: string;
}>;
type BatchRow = Readonly<{
  id: string;
  assurance: "software_only" | "external";
  provider_code: string;
  template_code: "pickup_reminder_v1";
  template_version: number;
  recipient_count: number;
  max_cost_cents: number;
  created_at: Date | string;
}>;
type DeliveryCountRow = Readonly<{
  batch_id: string;
  status: NotificationDeliveryStatus;
  cost_cents: number;
  updated_at: Date | string;
}>;
type DeliveryViewRow = Readonly<{
  id: string;
  order_id: string;
  ticket_no: string;
  status: NotificationDeliveryStatus;
  attempt_count: number;
  next_attempt_at: Date | string | null;
  last_error_code: string | null;
  cost_cents: number;
  updated_at: Date | string;
}>;

const date = (value: Date | string): Date => {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError("Invalid notification timestamp");
  return parsed;
};

function canonicalStatuses(statuses: readonly ("ready" | "racked")[]) {
  return Object.freeze(
    (["ready", "racked"] as const).filter((status) => statuses.includes(status)),
  );
}

function summary(batch: BatchRow, deliveries: readonly DeliveryCountRow[]) {
  return buildDeliveryBatchSummary({
    id: batch.id,
    assurance: batch.assurance,
    providerCode: batch.provider_code,
    templateCode: batch.template_code,
    templateVersion: batch.template_version,
    recipientCount: batch.recipient_count,
    maxCostCents: batch.max_cost_cents,
    createdAt: date(batch.created_at),
    deliveries: deliveries.map((delivery) => ({
      status: delivery.status,
      costCents: delivery.cost_cents,
      updatedAt: date(delivery.updated_at),
    })),
  });
}

async function loadBatchRows(
  client: Parameters<NotificationDeliveryStore["listBatches"]>[0],
  orgId: string,
  storeId: string,
  limit: number,
  batchId?: string,
) {
  const result = await client.query<BatchRow>(
    `SELECT id, assurance, provider_code, template_code, template_version,
            recipient_count, max_cost_cents, created_at
       FROM notification_delivery_batches
      WHERE org_id = $1::uuid
        AND store_id = $2::uuid
        AND ($3::uuid IS NULL OR id = $3::uuid)
      ORDER BY created_at DESC, id DESC
      LIMIT $4::integer`,
    [orgId, storeId, batchId ?? null, limit],
  );
  return result.rows;
}

async function loadDeliveryCounts(
  client: Parameters<NotificationDeliveryStore["listBatches"]>[0],
  orgId: string,
  storeId: string,
  batchIds: readonly string[],
) {
  if (batchIds.length === 0) return Object.freeze([]);
  const result = await client.query<DeliveryCountRow>(
    `SELECT batch_id, status, cost_cents, updated_at
       FROM notification_deliveries
      WHERE org_id = $1::uuid
        AND store_id = $2::uuid
        AND batch_id = ANY($3::uuid[])
      ORDER BY batch_id, created_at, id`,
    [orgId, storeId, batchIds],
  );
  return result.rows;
}

async function enqueueBatch(request: NotificationDeliveryEnqueueRequest) {
  const batchResult = await request.client.query<Readonly<{ created_at: Date | string }>>(
    `INSERT INTO notification_delivery_batches (
       id, org_id, store_id, provider_code, assurance, channel,
       template_id, template_code, template_version, min_age_days,
       unpaid_only, garment_statuses, recipient_count, estimated_cost_cents,
       max_cost_cents, created_by_staff_id, created_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, $5, 'sms',
       $6::uuid, $7, $8::integer, $9::integer,
       $10::boolean, $11::text[], $12::integer, $13::integer,
       $14::integer, $15::uuid, statement_timestamp()
     ) RETURNING created_at`,
    [
      request.batchId,
      request.tenant.orgId,
      request.tenant.storeId,
      request.providerCode,
      request.assurance,
      request.template.id,
      request.template.code,
      request.template.version,
      request.input.min_age_days,
      request.input.unpaid_only,
      canonicalStatuses(request.input.garment_statuses),
      request.deliveries.length,
      request.estimatedCostCents,
      request.input.max_cost_cents,
      request.createdByStaffId,
    ],
  );
  const batchCreatedAt = batchResult.rows[0]?.created_at;
  if (batchCreatedAt === undefined)
    throw new Error("Notification batch insert did not return time");
  const createdAt = date(batchCreatedAt);
  for (const delivery of request.deliveries) {
    await request.client.query(
      `INSERT INTO notification_deliveries (
         id, org_id, store_id, batch_id, order_id, customer_id, status,
         recipient_hmac, message_sha256, attempt_count, next_attempt_at,
         cost_cents, created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 'queued',
         NULL, $7, 0, $8::timestamptz, 0, $8::timestamptz, $8::timestamptz
       )`,
      [
        delivery.id,
        request.tenant.orgId,
        request.tenant.storeId,
        request.batchId,
        delivery.candidate.order_id,
        delivery.candidate.customer_id,
        delivery.messageSha256,
        createdAt.toISOString(),
      ],
    );
  }
  return NotificationDeliveryBatchEnqueueResultSchema.parse({
    batch_id: request.batchId,
    status: "queued",
    assurance: request.assurance,
    provider_code: request.providerCode,
    channel: "sms",
    template_code: request.template.code,
    template_version: request.template.version,
    recipient_count: request.deliveries.length,
    order_count: request.deliveries.length,
    estimated_cost_cents: request.estimatedCostCents,
    max_cost_cents: request.input.max_cost_cents,
    created_at: createdAt.toISOString(),
  });
}

async function assertOrdersAvailable(
  client: Parameters<NotificationDeliveryStore["assertOrdersAvailable"]>[0],
  tenant: Parameters<NotificationDeliveryStore["assertOrdersAvailable"]>[1],
  orderIds: readonly string[],
): Promise<boolean> {
  const result = await client.query<Readonly<{ id: string }>>(
    `SELECT id
       FROM notification_deliveries
      WHERE org_id = $1::uuid AND store_id = $2::uuid
        AND order_id = ANY($3::uuid[])
      LIMIT 1`,
    [tenant.orgId, tenant.storeId, orderIds],
  );
  return result.rowCount === 0;
}

export function createPgNotificationDeliveryReadStore(): NotificationDeliveryStore {
  return Object.freeze({
    getActiveTemplate: async (
      client,
      tenant,
      code,
    ): Promise<NotificationTemplateSnapshot | null> => {
      const result = await client.query<TemplateRow>(
        `SELECT id, code, version, channel, body
           FROM notification_templates
          WHERE org_id = $1::uuid AND code = $2 AND status = 'active'
          ORDER BY version DESC
          LIMIT 1`,
        [tenant.orgId, code],
      );
      const row = result.rows[0];
      return row === undefined ? null : Object.freeze({ ...row });
    },
    assertOrdersAvailable,
    enqueueBatch,
    listBatches: async (
      client,
      tenant,
      limit,
    ): Promise<readonly NotificationDeliveryBatchSummary[]> => {
      const batches = await loadBatchRows(client, tenant.orgId, tenant.storeId, limit);
      const deliveries = await loadDeliveryCounts(
        client,
        tenant.orgId,
        tenant.storeId,
        batches.map((batch) => batch.id),
      );
      return Object.freeze(
        batches.map((batch) =>
          summary(
            batch,
            deliveries.filter((delivery) => delivery.batch_id === batch.id),
          ),
        ),
      );
    },
    getBatch: async (client, tenant, batchId) => {
      const batch = (await loadBatchRows(client, tenant.orgId, tenant.storeId, 1, batchId))[0];
      if (batch === undefined) return null;
      const counts = await loadDeliveryCounts(client, tenant.orgId, tenant.storeId, [batch.id]);
      const result = await client.query<DeliveryViewRow>(
        `SELECT delivery.id, delivery.order_id, orders.ticket_no,
                delivery.status, delivery.attempt_count, delivery.next_attempt_at,
                delivery.last_error_code, delivery.cost_cents, delivery.updated_at
           FROM notification_deliveries delivery
           JOIN orders ON orders.org_id = delivery.org_id
             AND orders.store_id = delivery.store_id AND orders.id = delivery.order_id
          WHERE delivery.org_id = $1::uuid
            AND delivery.store_id = $2::uuid
            AND delivery.batch_id = $3::uuid
          ORDER BY delivery.created_at, delivery.id
          LIMIT 50`,
        [tenant.orgId, tenant.storeId, batch.id],
      );
      return NotificationDeliveryBatchGetResultSchema.parse({
        batch: summary(batch, counts),
        deliveries: result.rows.map((row) =>
          NotificationDeliveryViewSchema.parse({
            delivery_id: row.id,
            order_id: row.order_id,
            ticket_no: row.ticket_no,
            status: row.status,
            attempt_count: row.attempt_count,
            next_attempt_at:
              row.next_attempt_at === null ? null : date(row.next_attempt_at).toISOString(),
            last_error_code: row.last_error_code,
            cost_cents: row.cost_cents,
            updated_at: date(row.updated_at).toISOString(),
          }),
        ),
      });
    },
  });
}
