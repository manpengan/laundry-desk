/**
 * Postgres OrderStore: laundry_app + withStoreGuc (SET LOCAL tenant GUCs).
 * Tables (owned by packages/db migration agent): orders, order_lines, garments, ticket_counters.
 */

import { randomUUID } from "node:crypto";

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
import { withStoreGuc } from "../db/tenant-guc-client.js";
import {
  buildLineIdByIndex,
  epochToDate,
  mapGarment,
  mapOrder,
  mapOrderLine,
  type GarmentRow,
  type OrderLineRow,
  type OrderRow,
} from "./pg-order-mappers.js";
import type { GarmentRecord, OrderRecord, OrderStore, PickupApplyResult } from "./types.js";

export type CreatePgOrderStoreOptions = Readonly<{
  /** Override UUID generation (tests). */
  newId?: () => string;
}>;

async function insertOrderRows(
  client: PgPoolClient,
  order: OrderRecord,
  garments: readonly GarmentRecord[],
  lineIdByIndex: ReadonlyMap<number, string>,
): Promise<void> {
  await client.query(
    `INSERT INTO orders (
       id, org_id, store_id, ticket_no, status,
       customer_phone, customer_name, note,
       subtotal_cents, payable_cents, paid_cents, balance_cents,
       created_at, updated_at, created_by_staff_id
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15
     )`,
    [
      order.order_id,
      order.org_id,
      order.store_id,
      order.ticket_no,
      order.status,
      order.customer_phone,
      order.customer_name,
      order.note,
      order.subtotal_cents,
      order.payable_cents,
      order.paid_cents,
      order.balance_cents,
      epochToDate(order.created_at),
      epochToDate(order.updated_at),
      order.created_by_staff_id,
    ],
  );

  for (const line of order.lines) {
    const lineId = lineIdByIndex.get(line.line_index);
    if (lineId === undefined) {
      throw new Error(`Missing line id for line_index=${line.line_index}`);
    }
    await client.query(
      `INSERT INTO order_lines (
         id, org_id, store_id, order_id, line_index,
         service_code, category_code, unit_price_cents, qty, line_total_cents,
         color, brand
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        lineId,
        order.org_id,
        order.store_id,
        order.order_id,
        line.line_index,
        line.service_code,
        line.category_code,
        line.unit_price_cents,
        line.qty,
        line.line_total_cents,
        line.color,
        line.brand,
      ],
    );
  }

  for (const g of garments) {
    const orderLineId = g.order_line_id ?? lineIdByIndex.get(g.line_index);
    if (orderLineId === undefined) {
      throw new Error(`Missing order_line_id for garment line_index=${g.line_index}`);
    }
    await client.query(
      `INSERT INTO garments (
         id, org_id, store_id, order_id, order_line_id, seq, barcode,
         service_code, category_code, unit_price_cents, color, brand, status
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        g.garment_id,
        g.org_id,
        g.store_id,
        g.order_id,
        orderLineId,
        g.seq,
        g.barcode,
        g.service_code,
        g.category_code,
        g.unit_price_cents,
        g.color,
        g.brand,
        g.status,
      ],
    );
  }
}

async function loadOrder(
  client: PgPoolClient,
  orgId: string,
  storeId: string,
  orderId: string,
): Promise<OrderRecord | null> {
  const orderResult = await client.query<OrderRow>(
    `SELECT id::text, org_id::text, store_id::text, ticket_no, status,
            customer_phone, customer_name, note,
            subtotal_cents, payable_cents, paid_cents, balance_cents,
            created_at, updated_at, created_by_staff_id::text
     FROM orders
     WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
     LIMIT 1`,
    [orgId, storeId, orderId],
  );
  const orderRow = orderResult.rows[0];
  if (orderRow === undefined) return null;

  const linesResult = await client.query<OrderLineRow>(
    `SELECT id::text, org_id::text, store_id::text, order_id::text, line_index,
            service_code, category_code, unit_price_cents, qty, line_total_cents,
            color, brand
     FROM order_lines
     WHERE org_id = $1::uuid AND store_id = $2::uuid AND order_id = $3::uuid
     ORDER BY line_index ASC`,
    [orgId, storeId, orderId],
  );
  const lines = linesResult.rows.map(mapOrderLine);
  return mapOrder(orderRow, lines);
}

async function loadGarments(
  client: PgPoolClient,
  orgId: string,
  storeId: string,
  orderId: string,
): Promise<readonly GarmentRecord[]> {
  const result = await client.query<GarmentRow>(
    `SELECT g.id::text, g.org_id::text, g.store_id::text, g.order_id::text,
            g.order_line_id::text, ol.line_index, g.seq, g.barcode,
            g.service_code, g.category_code, g.unit_price_cents,
            g.color, g.brand, g.status
     FROM garments g
     INNER JOIN order_lines ol
       ON ol.org_id = g.org_id AND ol.store_id = g.store_id
      AND ol.order_id = g.order_id AND ol.id = g.order_line_id
     WHERE g.org_id = $1::uuid AND g.store_id = $2::uuid AND g.order_id = $3::uuid
     ORDER BY ol.line_index ASC, g.seq ASC`,
    [orgId, storeId, orderId],
  );
  return Object.freeze(result.rows.map(mapGarment));
}

function nextOrderStatus(
  garments: readonly GarmentRecord[],
  current: OrderRecord["status"],
  balanceCents: number,
): OrderRecord["status"] {
  const allTerminal = garments.every(
    (g) => g.status === "picked_up" || g.status === "delivered" || g.status === "lost",
  );
  return allTerminal && balanceCents <= 0 ? "closed" : current;
}

async function applyPickupTxn(
  client: PgPoolClient,
  orgId: string,
  storeId: string,
  orderId: string,
  garmentIds: readonly string[],
  collectCents: number,
  nowEpoch: number,
): Promise<PickupApplyResult | null> {
  const order = await loadOrder(client, orgId, storeId, orderId);
  if (order === null) return null;
  const garments = await loadGarments(client, orgId, storeId, orderId);
  if (garments.length === 0 && garmentIds.length > 0) return null;

  if (garmentIds.length > 0) {
    await client.query(
      `UPDATE garments
       SET status = 'picked_up'
       WHERE org_id = $1::uuid AND store_id = $2::uuid AND order_id = $3::uuid
         AND id = ANY($4::uuid[])`,
      [orgId, storeId, orderId, [...garmentIds]],
    );
  }

  const idSet = new Set(garmentIds);
  const nextGarments = garments.map((g) =>
    idSet.has(g.garment_id) ? Object.freeze({ ...g, status: "picked_up" as const }) : g,
  );
  const paid = order.paid_cents + collectCents;
  const balance = order.payable_cents - paid;
  const status = nextOrderStatus(nextGarments, order.status, balance);

  await client.query(
    `UPDATE orders
     SET paid_cents = $4, balance_cents = $5, status = $6, updated_at = $7
     WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
    [orgId, storeId, orderId, paid, balance, status, epochToDate(nowEpoch)],
  );

  const nextOrder = Object.freeze({
    ...order,
    paid_cents: paid,
    balance_cents: balance,
    status,
    updated_at: nowEpoch,
  });
  return Object.freeze({ order: nextOrder, garments: Object.freeze(nextGarments) });
}

/**
 * Create an OrderStore backed by Postgres under laundry_app RLS GUC scope.
 */
export function createPgOrderStore(
  pool: PgPool,
  options: CreatePgOrderStoreOptions = {},
): OrderStore {
  const newId = options.newId ?? randomUUID;

  return Object.freeze({
    insertOrder: async (order, garments) => {
      const lineIdByIndex = buildLineIdByIndex(order.lines, newId);
      await withStoreGuc(
        pool,
        {
          orgId: order.org_id,
          storeId: order.store_id,
          staffId: order.created_by_staff_id,
        },
        async (client) => {
          await insertOrderRows(client, order, garments, lineIdByIndex);
        },
      );
    },

    getOrder: async (orgId, storeId, orderId) =>
      withStoreGuc(pool, { orgId, storeId }, async (client) =>
        loadOrder(client, orgId, storeId, orderId),
      ),

    listGarments: async (orgId, storeId, orderId) =>
      withStoreGuc(pool, { orgId, storeId }, async (client) =>
        loadGarments(client, orgId, storeId, orderId),
      ),

    applyPickup: async (orgId, storeId, orderId, garmentIds, collectCents, nowEpoch) =>
      withStoreGuc(pool, { orgId, storeId }, async (client) =>
        applyPickupTxn(client, orgId, storeId, orderId, garmentIds, collectCents, nowEpoch),
      ),

    nextTicketSeq: async (orgId, storeId, dayKey) =>
      withStoreGuc(pool, { orgId, storeId }, async (client) => {
        const result = await client.query<{ last_seq: number }>(
          `INSERT INTO ticket_counters (org_id, store_id, day_key, last_seq)
           VALUES ($1::uuid, $2::uuid, $3, 1)
           ON CONFLICT (org_id, store_id, day_key)
           DO UPDATE SET last_seq = ticket_counters.last_seq + 1
           RETURNING last_seq`,
          [orgId, storeId, dayKey],
        );
        const row = result.rows[0];
        if (row === undefined) {
          throw new Error("ticket_counters UPSERT returned no row");
        }
        return row.last_seq;
      }),
  });
}
