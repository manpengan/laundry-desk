/**
 * Postgres OrderStore: laundry_app + withStoreGuc (SET LOCAL tenant GUCs).
 * Tables: orders, order_lines, garments, ticket_counters, payments (append-only).
 */

import { buildPayPayment } from "@laundry/domain";
import { randomUUID } from "node:crypto";

import type { PgPool } from "../db/pg-pool.js";
import { withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import type { SqlClient } from "../db/types.js";
import {
  asOrderStatus,
  buildLineIdByIndex,
  dateToEpoch,
  epochToDate,
  mapGarment,
  mapOrder,
  mapOrderLine,
  type GarmentRow,
  type OrderLineRow,
  type OrderRow,
} from "./pg-order-mappers.js";
import type {
  GarmentRecord,
  OrderListSummary,
  OrderListSummaryOptions,
  OrderRecord,
  OrderStore,
  PickupApplyOptions,
  PickupApplyResult,
} from "./types.js";

export type CreatePgOrderStoreOptions = Readonly<{
  /** Override UUID generation (tests). */
  newId?: () => string;
}>;

const POSTGRES_INTEGER_MAX = 2_147_483_647;

type OrderListSummaryRow = Readonly<{
  order_id: string;
  ticket_no: string;
  status: string;
  customer_phone: string | null;
  customer_name: string | null;
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
  created_at: Date | string;
  garment_count: number;
}>;

function utcBusinessDateBounds(
  businessDate: string | undefined,
): readonly [Date | null, Date | null] {
  if (businessDate === undefined) return Object.freeze([null, null]);
  const start = new Date(`${businessDate}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== businessDate) {
    throw new Error(`Invalid business date: ${businessDate}`);
  }
  return Object.freeze([start, new Date(start.getTime() + 86_400_000)]);
}

function mapOrderListSummary(row: OrderListSummaryRow): OrderListSummary {
  return Object.freeze({
    order_id: row.order_id,
    ticket_no: row.ticket_no,
    status: asOrderStatus(row.status),
    customer_phone: row.customer_phone,
    customer_name: row.customer_name,
    payable_cents: row.payable_cents,
    paid_cents: row.paid_cents,
    balance_cents: row.balance_cents,
    created_at: dateToEpoch(row.created_at),
    garment_count: row.garment_count,
  });
}

async function listOrderSummaries(
  client: SqlClient,
  orgId: string,
  storeId: string,
  options: OrderListSummaryOptions,
): Promise<readonly OrderListSummary[]> {
  const [dayStart, dayEnd] = utcBusinessDateBounds(options.businessDate);
  if (options.minBalanceCents !== undefined && options.minBalanceCents > POSTGRES_INTEGER_MAX) {
    return Object.freeze([]);
  }
  const result = await client.query<OrderListSummaryRow>(
    `SELECT o.id::text AS order_id, o.ticket_no, o.status,
            o.customer_phone, o.customer_name,
            o.payable_cents, o.paid_cents, o.balance_cents, o.created_at,
            COUNT(g.id)::integer AS garment_count
     FROM orders o
     LEFT JOIN garments g
       ON g.org_id = o.org_id AND g.store_id = o.store_id AND g.order_id = o.id
     WHERE o.org_id = $1::uuid AND o.store_id = $2::uuid
       AND ($3::text IS NULL OR o.status = $3)
       AND ($4::text IS NULL OR o.customer_phone = $4)
       AND ($5::timestamptz IS NULL OR o.created_at >= $5)
       AND ($6::timestamptz IS NULL OR o.created_at < $6)
       AND ($7::integer IS NULL OR o.balance_cents >= $7)
     GROUP BY o.id, o.ticket_no, o.status, o.customer_phone, o.customer_name,
              o.payable_cents, o.paid_cents, o.balance_cents, o.created_at
     ORDER BY o.created_at DESC, o.ticket_no DESC
     LIMIT $8`,
    [
      orgId,
      storeId,
      options.status ?? null,
      options.customerPhone ?? null,
      dayStart,
      dayEnd,
      options.minBalanceCents ?? null,
      options.limit,
    ],
  );
  return Object.freeze(result.rows.map(mapOrderListSummary));
}

async function insertOrderRows(
  client: SqlClient,
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
  client: SqlClient,
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
  client: SqlClient,
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
  balanceCents: number,
): OrderRecord["status"] {
  const allTerminal = garments.every(
    (g) => g.status === "picked_up" || g.status === "delivered" || g.status === "lost",
  );
  return allTerminal && balanceCents === 0 ? "closed" : "open";
}

async function insertPaymentIfNeeded(
  client: SqlClient,
  orgId: string,
  storeId: string,
  orderId: string,
  collectCents: number,
  nowEpoch: number,
  options: PickupApplyOptions | undefined,
  newId: () => string,
): Promise<void> {
  if (collectCents <= 0) return;
  if (options?.staffId === undefined || options.staffId.length === 0) {
    throw new Error("staffId is required when collectCents > 0");
  }
  const payment = buildPayPayment({
    payment_id: options.paymentId ?? newId(),
    org_id: orgId,
    store_id: storeId,
    order_id: orderId,
    amount_cents: collectCents,
    staff_id: options.staffId,
    at: nowEpoch,
    method: options.method ?? "cash",
  });
  await client.query(
    `INSERT INTO payments (
       id, org_id, store_id, order_id, method, amount_cents, kind,
       ref_payment_id, staff_id, at, note
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
       $8::uuid, $9::uuid, $10, $11
     )`,
    [
      payment.payment_id,
      payment.org_id,
      payment.store_id,
      payment.order_id,
      payment.method,
      payment.amount_cents,
      payment.kind,
      payment.ref_payment_id,
      payment.staff_id,
      epochToDate(payment.at),
      payment.note,
    ],
  );
}

async function applyPickupTxn(
  client: SqlClient,
  orgId: string,
  storeId: string,
  orderId: string,
  garmentIds: readonly string[],
  collectCents: number,
  nowEpoch: number,
  options: PickupApplyOptions | undefined,
  newId: () => string,
): Promise<PickupApplyResult | null> {
  const order = await loadOrder(client, orgId, storeId, orderId);
  if (order === null || order.status !== "open") return null;
  const garments = await loadGarments(client, orgId, storeId, orderId);
  if (garments.length === 0 && garmentIds.length > 0) return null;

  const idSet = new Set(garmentIds);
  const nextGarments = garments.map((g) =>
    idSet.has(g.garment_id) ? Object.freeze({ ...g, status: "picked_up" as const }) : g,
  );
  const paid = order.paid_cents + collectCents;
  const balance = order.payable_cents - paid;
  const status = nextOrderStatus(nextGarments, balance);
  assertPickupPlanMatchesCurrentRows(options, balance, status);

  if (garmentIds.length > 0) {
    await client.query(
      `UPDATE garments
       SET status = 'picked_up'
       WHERE org_id = $1::uuid AND store_id = $2::uuid AND order_id = $3::uuid
         AND id = ANY($4::uuid[])`,
      [orgId, storeId, orderId, [...garmentIds]],
    );
  }

  await client.query(
    `UPDATE orders
     SET paid_cents = $4, balance_cents = $5, status = $6, updated_at = $7
     WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
    [orgId, storeId, orderId, paid, balance, status, epochToDate(nowEpoch)],
  );

  await insertPaymentIfNeeded(
    client,
    orgId,
    storeId,
    orderId,
    collectCents,
    nowEpoch,
    options,
    newId,
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

function assertPickupPlanMatchesCurrentRows(
  options: PickupApplyOptions | undefined,
  balanceCents: number,
  nextStatus: OrderRecord["status"],
): void {
  if (options?.nextBalanceCents !== undefined && options.nextBalanceCents !== balanceCents) {
    throw new Error("Pickup plan balance no longer matches persisted order");
  }
  if (options?.nextOrderStatus !== undefined && options.nextOrderStatus !== nextStatus) {
    throw new Error("Pickup plan status no longer matches persisted order");
  }
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
      await withStoreGucOrCurrent(
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
      withStoreGucOrCurrent(pool, { orgId, storeId }, async (client) =>
        loadOrder(client, orgId, storeId, orderId),
      ),

    listOrders: async (orgId, storeId) =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, async (client) => {
        const orderResult = await client.query<OrderRow>(
          `SELECT id::text, org_id::text, store_id::text, ticket_no, status,
                  customer_phone, customer_name, note,
                  subtotal_cents, payable_cents, paid_cents, balance_cents,
                  created_at, updated_at, created_by_staff_id::text
           FROM orders
           WHERE org_id = $1::uuid AND store_id = $2::uuid
           ORDER BY created_at ASC`,
          [orgId, storeId],
        );
        const orders: OrderRecord[] = [];
        for (const row of orderResult.rows) {
          const linesResult = await client.query<OrderLineRow>(
            `SELECT id::text, org_id::text, store_id::text, order_id::text, line_index,
                    service_code, category_code, unit_price_cents, qty, line_total_cents,
                    color, brand
             FROM order_lines
             WHERE org_id = $1::uuid AND store_id = $2::uuid AND order_id = $3::uuid
             ORDER BY line_index ASC`,
            [orgId, storeId, row.id],
          );
          orders.push(mapOrder(row, linesResult.rows.map(mapOrderLine)));
        }
        return Object.freeze(orders);
      }),

    listOrderSummaries: async (orgId, storeId, options) =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, async (client) =>
        listOrderSummaries(client, orgId, storeId, options),
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
        if (row === undefined) {
          throw new Error("ticket_counters UPSERT returned no row");
        }
        return row.last_seq;
      }),
  });
}
