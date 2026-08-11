/** PostgreSQL OrderStore adapter; command operations run under tenant-local GUCs. */

import { randomUUID } from "node:crypto";

import type { PgPool } from "../db/pg-pool.js";
import { withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import { buildLineIdByIndex } from "./pg-order-mappers.js";
import { insertOrderRows, listOrderSummaries, loadGarments, loadOrder } from "./pg-order-data.js";
import { lookupOrderSummaries } from "./pg-order-lookup.js";
import {
  appendPaymentTxn,
  applyPickupTxn,
  cancelOrderTxn,
  insertInitialPayment,
  replaceDraftTxn,
} from "./pg-order-operations.js";
import { listPaymentRows } from "./pg-payment-rows.js";
import { appendRefundTxn } from "./pg-order-refund.js";
import type { OrderRecord, OrderStore } from "./types.js";

export type CreatePgOrderStoreOptions = Readonly<{
  /** Override UUID generation (tests). */
  newId?: () => string;
}>;

/** Create an OrderStore backed by PostgreSQL under laundry_app RLS GUC scope. */
export function createPgOrderStore(
  pool: PgPool,
  options: CreatePgOrderStoreOptions = {},
): OrderStore {
  const newId = options.newId ?? randomUUID;

  return Object.freeze({
    insertOrder: async (order, garments, initialPayment) => {
      const lineIdByIndex = buildLineIdByIndex(order.lines, newId);
      await withStoreGucOrCurrent(
        pool,
        {
          orgId: order.org_id,
          storeId: order.store_id,
          staffId: order.created_by_staff_id,
        },
        async (client) => {
          await insertOrderRows(client, order, garments, lineIdByIndex);
          await insertInitialPayment(client, initialPayment);
        },
      );
    },

    replaceDraft: async (order, garments, initialPayment, options) =>
      withStoreGucOrCurrent(
        pool,
        {
          orgId: order.org_id,
          storeId: order.store_id,
          staffId: order.created_by_staff_id,
        },
        async (client) =>
          replaceDraftTxn(
            client,
            order,
            garments,
            initialPayment,
            newId,
            options?.requireExisting === true,
          ),
      ),

    getOrder: async (orgId, storeId, orderId) =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, async (client) =>
        loadOrder(client, orgId, storeId, orderId),
      ),

    listOrders: async (orgId, storeId) =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, async (client) => {
        const result = await client.query<Readonly<{ id: string }>>(
          `SELECT id::text FROM orders
           WHERE org_id = $1::uuid AND store_id = $2::uuid
           ORDER BY created_at ASC`,
          [orgId, storeId],
        );
        const orders: OrderRecord[] = [];
        for (const row of result.rows) {
          const order = await loadOrder(client, orgId, storeId, row.id);
          if (order !== null) orders.push(order);
        }
        return Object.freeze(orders);
      }),

    listOrderSummaries: async (orgId, storeId, options) =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, async (client) =>
        listOrderSummaries(client, orgId, storeId, options),
      ),

    lookupOrderSummaries: async (orgId, storeId, options) =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, async (client) =>
        lookupOrderSummaries(client, orgId, storeId, options),
      ),

    listGarments: async (orgId, storeId, orderId) =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, async (client) =>
        loadGarments(client, orgId, storeId, orderId),
      ),

    applyPickup: async (orgId, storeId, orderId, garmentIds, collectCents, nowEpoch, options) => {
      const scope =
        options?.staffId !== undefined
          ? Object.freeze({ orgId, storeId, staffId: options.staffId })
          : Object.freeze({ orgId, storeId });
      return withStoreGucOrCurrent(pool, scope, async (client) =>
        applyPickupTxn(
          client,
          orgId,
          storeId,
          orderId,
          garmentIds,
          collectCents,
          nowEpoch,
          options,
          newId,
        ),
      );
    },

    listPayments: async (orgId, storeId, orderId, limit) =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, async (client) =>
        listPaymentRows(client, orgId, storeId, orderId, limit),
      ),

    appendPayment: async (input) =>
      withStoreGucOrCurrent(
        pool,
        { orgId: input.org_id, storeId: input.store_id, staffId: input.staff_id },
        async (client) => appendPaymentTxn(client, input, newId),
      ),

    appendRefund: async (input) =>
      withStoreGucOrCurrent(
        pool,
        { orgId: input.org_id, storeId: input.store_id, staffId: input.staff_id },
        async (client) => appendRefundTxn(client, input, newId),
      ),

    cancelOpenOrder: async (orgId, storeId, orderId, reason, staffId, at, businessDate) =>
      withStoreGucOrCurrent(pool, { orgId, storeId, staffId }, async (client) =>
        cancelOrderTxn(client, orgId, storeId, orderId, reason, staffId, at, businessDate, newId),
      ),

    nextTicketSeq: async (orgId, storeId, dayKey) =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, async (client) => {
        const result = await client.query<{ last_seq: number }>(
          `INSERT INTO ticket_counters (org_id, store_id, day_key, last_seq)
           VALUES ($1::uuid, $2::uuid, $3, 1)
           ON CONFLICT (org_id, store_id, day_key)
           DO UPDATE SET last_seq = ticket_counters.last_seq + 1
           RETURNING last_seq`,
          [orgId, storeId, dayKey],
        );
        const row = result.rows[0];
        if (row === undefined) throw new Error("ticket_counters UPSERT returned no row");
        return row.last_seq;
      }),
  });
}
