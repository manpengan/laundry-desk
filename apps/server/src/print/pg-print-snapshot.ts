import {
  PrintPaymentMethodSchema,
  PrintSnapshotSchema,
  type PrintSnapshot,
} from "@laundry/contracts";

import type { SqlClient } from "../db/types.js";

type OrderSnapshotRow = Readonly<{
  id: string;
  ticket_no: string | null;
  status: string;
  customer_name: string | null;
  customer_phone: string | null;
  note: string | null;
  original_cents: number;
  discount_cents: number;
  addon_cents: number;
  urgent_cents: number;
  freight_cents: number;
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
  created_at: Date;
  store_name: string;
}>;

type LineSnapshotRow = Readonly<{
  line_index: number;
  service_code: string;
  category_code: string;
  unit_price_cents: number;
  qty: number;
  line_total_cents: number;
  color: string | null;
  brand: string | null;
}>;

async function loadOrder(
  client: SqlClient,
  orgId: string,
  storeId: string,
  orderId: string,
): Promise<OrderSnapshotRow | null> {
  const result = await client.query<OrderSnapshotRow>(
    `SELECT order_row.id::text, order_row.ticket_no, order_row.status,
            order_row.customer_name, order_row.customer_phone, order_row.note,
            order_row.original_cents, order_row.discount_cents, order_row.addon_cents,
            order_row.urgent_cents, order_row.freight_cents, order_row.payable_cents,
            order_row.paid_cents, order_row.balance_cents, order_row.created_at,
            store.name AS store_name
       FROM orders AS order_row
       JOIN stores AS store
         ON store.org_id = order_row.org_id AND store.id = order_row.store_id
      WHERE order_row.org_id = $1::uuid AND order_row.store_id = $2::uuid
        AND order_row.id = $3::uuid AND order_row.ticket_no IS NOT NULL
        AND order_row.status IN ('open', 'closed')
      FOR SHARE OF order_row`,
    [orgId, storeId, orderId],
  );
  return result.rows[0] ?? null;
}

async function loadLines(
  client: SqlClient,
  orgId: string,
  storeId: string,
  orderId: string,
): Promise<readonly LineSnapshotRow[]> {
  const result = await client.query<LineSnapshotRow>(
    `SELECT line_index, service_code, category_code, unit_price_cents, qty,
            line_total_cents, color, brand
       FROM order_lines
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND order_id = $3::uuid
      ORDER BY line_index ASC`,
    [orgId, storeId, orderId],
  );
  return result.rows;
}

async function loadPaymentMethods(
  client: SqlClient,
  orgId: string,
  storeId: string,
  orderId: string,
): Promise<readonly string[]> {
  const result = await client.query<{ method: string }>(
    `WITH signed AS (
       SELECT CASE WHEN payment.kind = 'reversal' THEN referenced.method ELSE payment.method END
                AS method,
              CASE
                WHEN payment.kind = 'refund' THEN -payment.amount_cents
                WHEN payment.kind = 'reversal' AND referenced.kind = 'refund'
                  THEN payment.amount_cents
                WHEN payment.kind = 'reversal' THEN -payment.amount_cents
                ELSE payment.amount_cents
              END AS net_cents
         FROM payments AS payment
         LEFT JOIN payments AS referenced
           ON referenced.org_id = payment.org_id
          AND referenced.store_id = payment.store_id
          AND referenced.id = payment.ref_payment_id
        WHERE payment.org_id = $1::uuid AND payment.store_id = $2::uuid
          AND payment.order_id = $3::uuid
     )
     SELECT method
       FROM signed
      GROUP BY method
     HAVING SUM(net_cents) > 0
      ORDER BY CASE method
        WHEN 'cash' THEN 1 WHEN 'wechat' THEN 2 WHEN 'alipay' THEN 3
        WHEN 'other' THEN 4 WHEN 'balance' THEN 5 ELSE 6 END`,
    [orgId, storeId, orderId],
  );
  return result.rows.map((row) => PrintPaymentMethodSchema.parse(row.method));
}

/** Read and lock the real order before producing its immutable print snapshot. */
export async function loadPgPrintSnapshot(
  client: SqlClient,
  orgId: string,
  storeId: string,
  orderId: string,
): Promise<PrintSnapshot | null> {
  const order = await loadOrder(client, orgId, storeId, orderId);
  if (order === null) return null;
  const [lines, paymentMethods] = await Promise.all([
    loadLines(client, orgId, storeId, orderId),
    loadPaymentMethods(client, orgId, storeId, orderId),
  ]);
  return PrintSnapshotSchema.parse({
    version: 1,
    store_name: order.store_name,
    store_phone: null,
    order_id: order.id,
    ticket_no: order.ticket_no,
    received_at: order.created_at.toISOString(),
    customer_name: order.customer_name,
    customer_phone: order.customer_phone,
    note: order.note,
    lines,
    totals: {
      original_cents: order.original_cents,
      discount_cents: order.discount_cents,
      addon_cents: order.addon_cents,
      urgent_cents: order.urgent_cents,
      freight_cents: order.freight_cents,
      payable_cents: order.payable_cents,
      paid_cents: order.paid_cents,
      balance_cents: order.balance_cents,
    },
    payment_methods: paymentMethods,
  });
}
