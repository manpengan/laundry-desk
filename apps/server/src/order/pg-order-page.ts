import type { SqlClient } from "../db/types.js";
import { asOrderStatus, dateToEpoch } from "./pg-order-mappers.js";
import type { OrderListSummary, OrderListSummaryOptions } from "./types.js";

type Row = Readonly<{
  order_id: string;
  ticket_no: string | null;
  status: string;
  customer_phone: string | null;
  customer_name: string | null;
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
  created_at: string;
  garment_count: number;
}>;

/** One SQL snapshot keeps the count and requested page consistent, including empty pages. */
export async function listOrderPage(
  client: SqlClient,
  orgId: string,
  storeId: string,
  options: OrderListSummaryOptions,
): Promise<Readonly<{ orders: readonly OrderListSummary[]; total: number }>> {
  if ((options.minBalanceCents ?? 0) > 2_147_483_647) return { orders: [], total: 0 };
  const result = await client.query<Readonly<{ orders: readonly Row[]; total: number }>>(
    `WITH filtered AS MATERIALIZED (
      SELECT o.id, o.org_id, o.store_id, o.ticket_no, o.status, o.customer_phone, o.customer_name,
        o.payable_cents, o.paid_cents, o.balance_cents, o.created_at FROM orders o
      WHERE o.org_id = $1::uuid AND o.store_id = $2::uuid
        AND ($3::text IS NULL OR o.status = $3)
        AND ($4::text IS NULL OR o.customer_phone = $4)
        AND ($5::text IS NULL OR o.business_date = $5)
        AND ($6::integer IS NULL OR o.balance_cents >= $6)
        AND ($7::uuid IS NULL OR o.customer_id = $7)
        AND ($8::text IS NULL OR o.ticket_no = $8)
        AND ($9::text IS NULL OR strpos(lower(coalesce(o.customer_name, '')), lower($9)) > 0
             OR strpos(coalesce(o.customer_phone, ''), $9) > 0)
        AND ($10::text IS NULL OR o.business_date >= $10)
        AND ($11::text IS NULL OR o.business_date <= $11)
        AND ($12::boolean IS NULL OR $12 = EXISTS (
          SELECT 1 FROM garments g WHERE g.org_id = o.org_id AND g.store_id = o.store_id
          AND g.order_id = o.id AND g.status = 'racked'))
    ), page AS (
      SELECT o.id::text AS order_id, o.ticket_no, o.status, o.customer_phone, o.customer_name,
        o.payable_cents, o.paid_cents, o.balance_cents, o.created_at,
        (SELECT COUNT(*)::integer FROM garments g WHERE g.org_id = o.org_id
          AND g.store_id = o.store_id AND g.order_id = o.id) AS garment_count
      FROM filtered o ORDER BY o.created_at DESC, o.ticket_no DESC NULLS LAST, o.id DESC LIMIT $13 OFFSET $14
    ) SELECT (SELECT COUNT(*)::integer FROM filtered) AS total,
      COALESCE((SELECT jsonb_agg(page ORDER BY created_at DESC, ticket_no DESC NULLS LAST, order_id DESC) FROM page), '[]'::jsonb) AS orders`,
    [
      orgId,
      storeId,
      options.status ?? null,
      options.customerPhone ?? null,
      options.businessDate ?? null,
      options.minBalanceCents ?? null,
      options.customerId ?? null,
      options.ticketNo ?? null,
      options.customerQuery ?? null,
      options.dateFrom ?? null,
      options.dateTo ?? null,
      options.readyForPickup ?? null,
      options.limit,
      options.offset ?? 0,
    ],
  );
  const value = result.rows[0];
  if (value === undefined) throw new Error("Order page query returned no aggregate row");
  return Object.freeze({
    total: value.total,
    orders: Object.freeze(
      value.orders.map((row) =>
        Object.freeze({
          ...row,
          status: asOrderStatus(row.status),
          created_at: dateToEpoch(row.created_at),
        }),
      ),
    ),
  });
}
