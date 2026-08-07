import type {
  OwnerDashboardDrilldownReadRequest,
  OwnerDashboardDrilldownSnapshot,
  OwnerNewReceivableDetail,
  OwnerStagnantGarmentDetail,
  OwnerTodayPickupDetail,
} from "./types.js";

type DetailRow = Readonly<{
  total_row_count: number | string;
  total_measure: number | string;
  ticket_no: string | null;
  occurred_at: Date | string | null;
  garment_count: number | string | null;
  balance_cents: number | string | null;
}>;

const TODAY_PICKUPS_SQL = `
  WITH grouped AS (
    SELECT picked_order.id AS order_id,
           picked_order.ticket_no,
           MAX(picked_log.at) AS occurred_at,
           COUNT(*)::bigint AS garment_count
      FROM garment_status_log AS picked_log
      JOIN orders AS picked_order
        ON picked_order.org_id = picked_log.org_id
       AND picked_order.store_id = picked_log.store_id
       AND picked_order.id = picked_log.order_id
     WHERE picked_log.org_id = $1::uuid
       AND picked_log.store_id = $2::uuid
       AND picked_order.org_id = $1::uuid
       AND picked_order.store_id = $2::uuid
       AND picked_log.to_status = 'picked_up'
       AND picked_log.at >= $3::timestamptz
       AND picked_log.at < $4::timestamptz
     GROUP BY picked_order.id, picked_order.ticket_no
  ),
  totals AS (
    SELECT COUNT(*)::bigint AS total_row_count,
           COALESCE(SUM(garment_count), 0)::bigint AS total_measure
      FROM grouped
  )
  SELECT totals.total_row_count,
         totals.total_measure,
         bounded.ticket_no,
         bounded.occurred_at,
         bounded.garment_count,
         NULL::bigint AS balance_cents
    FROM totals
    LEFT JOIN LATERAL (
      SELECT ticket_no, occurred_at, garment_count
        FROM grouped
       ORDER BY occurred_at DESC, ticket_no ASC
       LIMIT $5::integer
    ) AS bounded ON true
   ORDER BY bounded.occurred_at DESC NULLS LAST, bounded.ticket_no ASC
`;

const NEW_RECEIVABLES_SQL = `
  WITH grouped AS (
    SELECT receivable_order.ticket_no,
           receivable_order.created_at AS occurred_at,
           receivable_order.balance_cents::bigint AS balance_cents
      FROM orders AS receivable_order
     WHERE receivable_order.org_id = $1::uuid
       AND receivable_order.store_id = $2::uuid
       AND receivable_order.business_date = $3
       AND receivable_order.status IN ('open', 'closed')
       AND receivable_order.balance_cents > 0
  ),
  totals AS (
    SELECT COUNT(*)::bigint AS total_row_count,
           COALESCE(SUM(balance_cents), 0)::bigint AS total_measure
      FROM grouped
  )
  SELECT totals.total_row_count,
         totals.total_measure,
         bounded.ticket_no,
         bounded.occurred_at,
         NULL::bigint AS garment_count,
         bounded.balance_cents
    FROM totals
    LEFT JOIN LATERAL (
      SELECT ticket_no, occurred_at, balance_cents
        FROM grouped
       ORDER BY occurred_at DESC, ticket_no ASC
       LIMIT $4::integer
    ) AS bounded ON true
   ORDER BY bounded.occurred_at DESC NULLS LAST, bounded.ticket_no ASC
`;

const STAGNANT_GARMENTS_SQL = `
  WITH grouped AS (
    SELECT stagnant_order.id AS order_id,
           stagnant_order.ticket_no,
           stagnant_order.created_at AS occurred_at,
           stagnant_order.balance_cents::bigint AS balance_cents,
           COUNT(*)::bigint AS garment_count
      FROM orders AS stagnant_order
      JOIN garments AS stagnant_garment
        ON stagnant_garment.org_id = stagnant_order.org_id
       AND stagnant_garment.store_id = stagnant_order.store_id
       AND stagnant_garment.order_id = stagnant_order.id
     WHERE stagnant_order.org_id = $1::uuid
       AND stagnant_order.store_id = $2::uuid
       AND stagnant_garment.org_id = $1::uuid
       AND stagnant_garment.store_id = $2::uuid
       AND stagnant_order.status = 'open'
       AND stagnant_order.created_at <= $3::timestamptz
       AND stagnant_garment.status IN ('ready', 'racked')
     GROUP BY stagnant_order.id, stagnant_order.ticket_no,
              stagnant_order.created_at, stagnant_order.balance_cents
  ),
  totals AS (
    SELECT COUNT(*)::bigint AS total_row_count,
           COALESCE(SUM(garment_count), 0)::bigint AS total_measure
      FROM grouped
  )
  SELECT totals.total_row_count,
         totals.total_measure,
         bounded.ticket_no,
         bounded.occurred_at,
         bounded.garment_count,
         bounded.balance_cents
    FROM totals
    LEFT JOIN LATERAL (
      SELECT ticket_no, occurred_at, garment_count, balance_cents
        FROM grouped
       ORDER BY occurred_at ASC, ticket_no ASC
       LIMIT $4::integer
    ) AS bounded ON true
   ORDER BY bounded.occurred_at ASC NULLS LAST, bounded.ticket_no ASC
`;

function requireNonNegativeSafeInteger(value: number | string, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError(`invalid PostgreSQL ${field}`);
  }
  return parsed;
}

function requiredText(value: string | null, field: string): string {
  if (value === null || value.length === 0) throw new TypeError(`missing PostgreSQL ${field}`);
  return value;
}

function requiredDate(value: Date | string | null, field: string): Date {
  if (value === null) throw new TypeError(`missing PostgreSQL ${field}`);
  const parsed = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`invalid PostgreSQL ${field}`);
  return parsed;
}

function totals(rows: readonly DetailRow[]): Readonly<{ rowCount: number; measure: number }> {
  const first = rows[0];
  if (first === undefined) throw new TypeError("missing PostgreSQL owner drilldown totals");
  const parsed = Object.freeze({
    rowCount: requireNonNegativeSafeInteger(first.total_row_count, "total_row_count"),
    measure: requireNonNegativeSafeInteger(first.total_measure, "total_measure"),
  });
  for (const row of rows) {
    if (
      requireNonNegativeSafeInteger(row.total_row_count, "total_row_count") !== parsed.rowCount ||
      requireNonNegativeSafeInteger(row.total_measure, "total_measure") !== parsed.measure
    ) {
      throw new TypeError("inconsistent PostgreSQL owner drilldown totals");
    }
  }
  return parsed;
}

function detailRows(rows: readonly DetailRow[], limit: number): readonly DetailRow[] {
  const details = rows.filter((row) => row.ticket_no !== null);
  if (details.length > limit) throw new TypeError("PostgreSQL owner drilldown exceeded limit");
  return Object.freeze(details);
}

function pickupSnapshot(
  rows: readonly DetailRow[],
  limit: number,
): OwnerDashboardDrilldownSnapshot {
  const total = totals(rows);
  const details: readonly OwnerTodayPickupDetail[] = detailRows(rows, limit).map((row) =>
    Object.freeze({
      ticketNo: requiredText(row.ticket_no, "ticket_no"),
      pickedAt: requiredDate(row.occurred_at, "occurred_at"),
      garmentCount: requireNonNegativeSafeInteger(row.garment_count ?? -1, "garment_count"),
    }),
  );
  return Object.freeze({
    kind: "today_pickups",
    totalRowCount: total.rowCount,
    pickedUpGarmentCount: total.measure,
    rows: details,
  });
}

function receivableSnapshot(
  rows: readonly DetailRow[],
  limit: number,
): OwnerDashboardDrilldownSnapshot {
  const total = totals(rows);
  const details: readonly OwnerNewReceivableDetail[] = detailRows(rows, limit).map((row) =>
    Object.freeze({
      ticketNo: requiredText(row.ticket_no, "ticket_no"),
      receivedAt: requiredDate(row.occurred_at, "occurred_at"),
      balanceCents: requireNonNegativeSafeInteger(row.balance_cents ?? -1, "balance_cents"),
    }),
  );
  return Object.freeze({
    kind: "new_receivables",
    totalRowCount: total.rowCount,
    newReceivableCents: total.measure,
    newReceivableOrderCount: total.rowCount,
    rows: details,
  });
}

function stagnantSnapshot(
  rows: readonly DetailRow[],
  limit: number,
): OwnerDashboardDrilldownSnapshot {
  const total = totals(rows);
  const details: readonly OwnerStagnantGarmentDetail[] = detailRows(rows, limit).map((row) =>
    Object.freeze({
      ticketNo: requiredText(row.ticket_no, "ticket_no"),
      receivedAt: requiredDate(row.occurred_at, "occurred_at"),
      garmentCount: requireNonNegativeSafeInteger(row.garment_count ?? -1, "garment_count"),
      balanceCents: requireNonNegativeSafeInteger(row.balance_cents ?? -1, "balance_cents"),
    }),
  );
  return Object.freeze({
    kind: "stagnant_garments",
    totalRowCount: total.rowCount,
    overdueGarmentCount: total.measure,
    overdueOrderCount: total.rowCount,
    rows: details,
  });
}

export async function readPgOwnerDrilldown(
  request: OwnerDashboardDrilldownReadRequest,
): Promise<OwnerDashboardDrilldownSnapshot> {
  const query =
    request.kind === "today_pickups"
      ? Object.freeze({
          sql: TODAY_PICKUPS_SQL,
          params: Object.freeze([
            request.tenant.orgId,
            request.tenant.storeId,
            request.dayStartedAt.toISOString(),
            request.nextDayStartedAt.toISOString(),
            request.limit,
          ]),
        })
      : request.kind === "new_receivables"
        ? Object.freeze({
            sql: NEW_RECEIVABLES_SQL,
            params: Object.freeze([
              request.tenant.orgId,
              request.tenant.storeId,
              request.businessDate,
              request.limit,
            ]),
          })
        : Object.freeze({
            sql: STAGNANT_GARMENTS_SQL,
            params: Object.freeze([
              request.tenant.orgId,
              request.tenant.storeId,
              request.overdueCutoff.toISOString(),
              request.limit,
            ]),
          });
  const result = await request.client.query<DetailRow>(query.sql, query.params);
  if (request.kind === "today_pickups") return pickupSnapshot(result.rows, request.limit);
  if (request.kind === "new_receivables") return receivableSnapshot(result.rows, request.limit);
  return stagnantSnapshot(result.rows, request.limit);
}
