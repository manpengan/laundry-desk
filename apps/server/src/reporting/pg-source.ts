import type { OwnerDashboardOperations, OwnerDashboardReadPort } from "./types.js";

type OperationsRow = Readonly<{
  picked_up_garment_count: number | string;
  new_receivable_cents: number | string;
  new_receivable_order_count: number | string;
  overdue_garment_count: number | string;
  overdue_order_count: number | string;
}>;

const OPERATIONS_SQL = `
  WITH picked_up AS (
    SELECT COUNT(*)::bigint AS garment_count
      FROM garment_status_log
     WHERE org_id = $1::uuid
       AND store_id = $2::uuid
       AND to_status = 'picked_up'
       AND at >= $4::timestamptz
       AND at < $5::timestamptz
  ),
  new_receivables AS (
    SELECT COALESCE(SUM(balance_cents), 0)::bigint AS receivable_cents,
           COUNT(*)::bigint AS order_count
      FROM orders
     WHERE org_id = $1::uuid
       AND store_id = $2::uuid
       AND business_date = $3
       AND status IN ('open', 'closed')
       AND balance_cents > 0
  ),
  overdue AS (
    SELECT COUNT(*)::bigint AS garment_count,
           COUNT(DISTINCT overdue_order.id)::bigint AS order_count
      FROM orders AS overdue_order
      JOIN garments AS overdue_garment
        ON overdue_garment.org_id = overdue_order.org_id
       AND overdue_garment.store_id = overdue_order.store_id
       AND overdue_garment.order_id = overdue_order.id
     WHERE overdue_order.org_id = $1::uuid
       AND overdue_order.store_id = $2::uuid
       AND overdue_order.status = 'open'
       AND overdue_order.created_at <= $6::timestamptz
       AND overdue_garment.status IN ('ready', 'racked')
  )
  SELECT picked_up.garment_count AS picked_up_garment_count,
         new_receivables.receivable_cents AS new_receivable_cents,
         new_receivables.order_count AS new_receivable_order_count,
         overdue.garment_count AS overdue_garment_count,
         overdue.order_count AS overdue_order_count
    FROM picked_up CROSS JOIN new_receivables CROSS JOIN overdue
`;

function requireNonNegativeSafeInteger(value: number | string, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError(`invalid PostgreSQL ${field}`);
  }
  return parsed;
}

function toOperations(row: OperationsRow | undefined): OwnerDashboardOperations {
  if (row === undefined) throw new TypeError("missing PostgreSQL owner dashboard aggregate");
  return Object.freeze({
    pickedUpGarmentCount: requireNonNegativeSafeInteger(
      row.picked_up_garment_count,
      "picked_up_garment_count",
    ),
    newReceivableCents: requireNonNegativeSafeInteger(
      row.new_receivable_cents,
      "new_receivable_cents",
    ),
    newReceivableOrderCount: requireNonNegativeSafeInteger(
      row.new_receivable_order_count,
      "new_receivable_order_count",
    ),
    overdueGarmentCount: requireNonNegativeSafeInteger(
      row.overdue_garment_count,
      "overdue_garment_count",
    ),
    overdueOrderCount: requireNonNegativeSafeInteger(
      row.overdue_order_count,
      "overdue_order_count",
    ),
  });
}

export function createPgOwnerDashboardSource(): OwnerDashboardReadPort {
  return Object.freeze({
    readOperations: async (request) => {
      const result = await request.client.query<OperationsRow>(OPERATIONS_SQL, [
        request.tenant.orgId,
        request.tenant.storeId,
        request.businessDate,
        request.dayStartedAt.toISOString(),
        request.nextDayStartedAt.toISOString(),
        request.overdueCutoff.toISOString(),
      ]);
      return toOperations(result.rows[0]);
    },
  });
}
