/** PostgreSQL order graph reads and writes shared by the store's command operations. */

import type { SqlClient } from "../db/types.js";
import {
  asOrderStatus,
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
} from "./types.js";

const POSTGRES_INTEGER_MAX = 2_147_483_647;

type OrderListSummaryRow = Readonly<{
  order_id: string;
  ticket_no: string | null;
  status: string;
  customer_phone: string | null;
  customer_name: string | null;
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
  created_at: Date | string;
  garment_count: number;
}>;

const mapOrderListSummary = (row: OrderListSummaryRow): OrderListSummary =>
  Object.freeze({
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

export async function listOrderSummaries(
  client: SqlClient,
  orgId: string,
  storeId: string,
  options: OrderListSummaryOptions,
): Promise<readonly OrderListSummary[]> {
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
       AND ($5::text IS NULL OR o.business_date = $5)
       AND ($6::integer IS NULL OR o.balance_cents >= $6)
     GROUP BY o.id, o.ticket_no, o.status, o.customer_phone, o.customer_name,
              o.payable_cents, o.paid_cents, o.balance_cents, o.created_at
     ORDER BY o.created_at DESC, o.ticket_no DESC
     LIMIT $7`,
    [
      orgId,
      storeId,
      options.status ?? null,
      options.customerPhone ?? null,
      options.businessDate ?? null,
      options.minBalanceCents ?? null,
      options.limit,
    ],
  );
  return Object.freeze(result.rows.map(mapOrderListSummary));
}

export async function insertOrderRows(
  client: SqlClient,
  order: OrderRecord,
  garments: readonly GarmentRecord[],
  lineIdByIndex: ReadonlyMap<number, string>,
): Promise<void> {
  await client.query(
    `INSERT INTO orders (
      id, org_id, store_id, ticket_no, pickup_code, status,
      customer_id, customer_phone, customer_name, note,
      subtotal_cents, original_cents, discount_cents, addon_cents, urgent_cents, freight_cents,
      payable_cents, paid_cents, balance_cents, business_date,
      created_at, updated_at, created_by_staff_id
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
     )`,
    [
      order.order_id,
      order.org_id,
      order.store_id,
      order.ticket_no,
      order.pickup_code,
      order.status,
      order.customer_id,
      order.customer_phone,
      order.customer_name,
      order.note,
      order.subtotal_cents,
      order.original_cents,
      order.discount_cents,
      order.addon_cents,
      order.urgent_cents,
      order.freight_cents,
      order.payable_cents,
      order.paid_cents,
      order.balance_cents,
      order.business_date,
      epochToDate(order.created_at),
      epochToDate(order.updated_at),
      order.created_by_staff_id,
    ],
  );
  await insertOrderChildren(client, order, garments, lineIdByIndex);
}

export async function insertOrderChildren(
  client: SqlClient,
  order: OrderRecord,
  garments: readonly GarmentRecord[],
  lineIdByIndex: ReadonlyMap<number, string>,
): Promise<void> {
  for (const line of order.lines) {
    const lineId = lineIdByIndex.get(line.line_index);
    if (lineId === undefined) throw new Error(`Missing line id for line_index=${line.line_index}`);
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

  for (const garment of garments) {
    const orderLineId = garment.order_line_id ?? lineIdByIndex.get(garment.line_index);
    if (orderLineId === undefined) {
      throw new Error(`Missing order_line_id for garment line_index=${garment.line_index}`);
    }
    await client.query(
      `INSERT INTO garments (
         id, org_id, store_id, order_id, order_line_id, seq, barcode,
         service_code, category_code, unit_price_cents, color, brand, status,
         rack_zone, rack_slot
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        garment.garment_id,
        garment.org_id,
        garment.store_id,
        garment.order_id,
        orderLineId,
        garment.seq,
        garment.barcode,
        garment.service_code,
        garment.category_code,
        garment.unit_price_cents,
        garment.color,
        garment.brand,
        garment.status,
        garment.rack_zone ?? null,
        garment.rack_slot ?? null,
      ],
    );
  }
}

export async function loadOrder(
  client: SqlClient,
  orgId: string,
  storeId: string,
  orderId: string,
  forUpdate = false,
): Promise<OrderRecord | null> {
  const orderResult = await client.query<OrderRow>(
    `SELECT id::text, org_id::text, store_id::text, ticket_no, pickup_code, status,
            customer_id::text, customer_phone, customer_name, note,
            subtotal_cents, original_cents, discount_cents, addon_cents, urgent_cents, freight_cents,
            payable_cents, paid_cents, balance_cents, business_date,
            created_at, updated_at, created_by_staff_id::text
     FROM orders
     WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
     LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
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
  return mapOrder(orderRow, linesResult.rows.map(mapOrderLine));
}

export async function loadGarments(
  client: SqlClient,
  orgId: string,
  storeId: string,
  orderId: string,
  forUpdate = false,
): Promise<readonly GarmentRecord[]> {
  const result = await client.query<GarmentRow>(
    `SELECT g.id::text, g.org_id::text, g.store_id::text, g.order_id::text,
            g.order_line_id::text, ol.line_index, g.seq, g.barcode,
            g.service_code, g.category_code, g.unit_price_cents,
            g.color, g.brand, g.status, g.rack_zone, g.rack_slot
     FROM garments g
     INNER JOIN order_lines ol
       ON ol.org_id = g.org_id AND ol.store_id = g.store_id
      AND ol.order_id = g.order_id AND ol.id = g.order_line_id
     WHERE g.org_id = $1::uuid AND g.store_id = $2::uuid AND g.order_id = $3::uuid
     ORDER BY ol.line_index ASC, g.seq ASC${forUpdate ? " FOR UPDATE OF g" : ""}`,
    [orgId, storeId, orderId],
  );
  return Object.freeze(result.rows.map(mapGarment));
}

export const nextOrderStatus = (
  garments: readonly GarmentRecord[],
  balanceCents: number,
): OrderRecord["status"] => {
  const allTerminal = garments.every(
    (garment) =>
      garment.status === "picked_up" || garment.status === "delivered" || garment.status === "lost",
  );
  return allTerminal && balanceCents === 0 ? "closed" : "open";
};
