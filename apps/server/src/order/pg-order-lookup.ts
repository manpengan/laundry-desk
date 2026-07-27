/** PostgreSQL implementation of the bounded counter identifier lookup. */

import type { SqlClient } from "../db/types.js";
import { asOrderStatus, dateToEpoch } from "./pg-order-mappers.js";
import type { OrderLookupMatchKind, OrderLookupOptions, OrderLookupSummary } from "./types.js";

type LookupSqlRow = Readonly<{
  order_id: string;
  ticket_no: string | null;
  pickup_code: string | null;
  status: string;
  customer_phone: string | null;
  customer_name: string | null;
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
  created_at: Date | string;
  garment_count: number;
  matched_by: string;
}>;

function asMatchKind(value: string): OrderLookupMatchKind {
  if (
    value === "ticket_no" ||
    value === "pickup_code" ||
    value === "garment_barcode" ||
    value === "customer_phone" ||
    value === "customer_name"
  ) {
    return value;
  }
  throw new Error(`Unknown order lookup match kind: ${value}`);
}

function mapLookupRow(row: LookupSqlRow): OrderLookupSummary {
  return Object.freeze({
    order_id: row.order_id,
    ticket_no: row.ticket_no,
    pickup_code: row.pickup_code,
    status: asOrderStatus(row.status),
    customer_phone: row.customer_phone,
    customer_name: row.customer_name,
    payable_cents: row.payable_cents,
    paid_cents: row.paid_cents,
    balance_cents: row.balance_cents,
    created_at: dateToEpoch(row.created_at),
    garment_count: row.garment_count,
    matched_by: asMatchKind(row.matched_by),
  });
}

/** All identifiers are store-scoped; `key` is bound once and the result remains capped. */
export async function lookupOrderSummaries(
  client: SqlClient,
  orgId: string,
  storeId: string,
  options: OrderLookupOptions,
): Promise<readonly OrderLookupSummary[]> {
  const result = await client.query<LookupSqlRow>(
    `SELECT o.id::text AS order_id, o.ticket_no, o.pickup_code, o.status,
            o.customer_phone, o.customer_name,
            o.payable_cents, o.paid_cents, o.balance_cents, o.created_at,
            COUNT(g.id)::integer AS garment_count,
            CASE
              WHEN o.ticket_no = $3 THEN 'ticket_no'
              WHEN o.pickup_code = $3 THEN 'pickup_code'
              WHEN EXISTS (
                SELECT 1 FROM garments matched_g
                WHERE matched_g.org_id = o.org_id AND matched_g.store_id = o.store_id
                  AND matched_g.order_id = o.id AND matched_g.barcode = $3
              ) THEN 'garment_barcode'
              WHEN o.customer_phone = $3 THEN 'customer_phone'
              ELSE 'customer_name'
            END AS matched_by
     FROM orders o
     LEFT JOIN garments g
       ON g.org_id = o.org_id AND g.store_id = o.store_id AND g.order_id = o.id
     WHERE o.org_id = $1::uuid AND o.store_id = $2::uuid
       AND ($4::text IS NULL OR o.status = $4)
       AND (
         o.ticket_no = $3 OR o.pickup_code = $3 OR o.customer_phone = $3
         OR EXISTS (
           SELECT 1 FROM garments matched_g
           WHERE matched_g.org_id = o.org_id AND matched_g.store_id = o.store_id
             AND matched_g.order_id = o.id AND matched_g.barcode = $3
         )
         OR lower(o.customer_name) LIKE lower($3) || '%'
       )
     GROUP BY o.id, o.ticket_no, o.pickup_code, o.status, o.customer_phone, o.customer_name,
              o.payable_cents, o.paid_cents, o.balance_cents, o.created_at
     ORDER BY CASE
                WHEN o.ticket_no = $3 THEN 0
                WHEN o.pickup_code = $3 THEN 1
                WHEN EXISTS (
                  SELECT 1 FROM garments ranked_g
                  WHERE ranked_g.org_id = o.org_id AND ranked_g.store_id = o.store_id
                    AND ranked_g.order_id = o.id AND ranked_g.barcode = $3
                ) THEN 2
                WHEN o.customer_phone = $3 THEN 3
                ELSE 4
              END,
              o.created_at DESC, o.ticket_no DESC
     LIMIT $5`,
    [orgId, storeId, options.key, options.status ?? null, options.limit],
  );
  return Object.freeze(result.rows.map(mapLookupRow));
}
