/** PostgreSQL day-summary query for the M2 counter runtime. */

import { emptyDaySummary, type DaySummary } from "@laundry/domain";

import type { PgPool } from "../db/pg-pool.js";
import { withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import type { SqlClient } from "../db/types.js";
import type { StatsDaySummaryInput, StatsQueryPort } from "./types.js";

type DaySummaryRow = Readonly<{
  order_count: number | string;
  garment_count: number | string;
  payable_cents: number | string;
  paid_cents: number | string;
  balance_cents: number | string;
  payment_cents: number | string;
  picked_garment_count: number | string;
}>;

function asSafeInteger(value: number | string, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${field} aggregate from PostgreSQL`);
  }
  return parsed;
}

function mapSummary(input: StatsDaySummaryInput, row: DaySummaryRow | undefined): DaySummary {
  if (row === undefined) return emptyDaySummary(input.businessDate);
  return Object.freeze({
    business_date: input.businessDate,
    order_count: asSafeInteger(row.order_count, "order_count"),
    garment_count: asSafeInteger(row.garment_count, "garment_count"),
    payable_cents: asSafeInteger(row.payable_cents, "payable_cents"),
    paid_cents: asSafeInteger(row.paid_cents, "paid_cents"),
    balance_cents: asSafeInteger(row.balance_cents, "balance_cents"),
    payment_cents: asSafeInteger(row.payment_cents, "payment_cents"),
    picked_garment_count: asSafeInteger(row.picked_garment_count, "picked_garment_count"),
  });
}

async function queryDaySummary(
  client: SqlClient,
  input: StatsDaySummaryInput,
): Promise<DaySummary> {
  const result = await client.query<DaySummaryRow>(
    `WITH orders_day AS (
       SELECT o.id, o.org_id, o.store_id, o.payable_cents, o.paid_cents, o.balance_cents
       FROM orders o
       WHERE o.org_id = $1::uuid AND o.store_id = $2::uuid
         AND o.business_date = $3
         AND o.status IN ('open', 'closed')
     )
     SELECT
       (SELECT COUNT(*)::integer FROM orders_day) AS order_count,
       (SELECT COUNT(*)::integer
          FROM garments g INNER JOIN orders_day o
            ON o.org_id = g.org_id AND o.store_id = g.store_id AND o.id = g.order_id
       ) AS garment_count,
       (SELECT COALESCE(SUM(payable_cents), 0)::bigint FROM orders_day) AS payable_cents,
       (SELECT COALESCE(SUM(paid_cents), 0)::bigint FROM orders_day) AS paid_cents,
       (SELECT COALESCE(SUM(balance_cents), 0)::bigint FROM orders_day) AS balance_cents,
       (SELECT COALESCE(SUM(p.amount_cents), 0)::bigint
          FROM payments p
         WHERE p.org_id = $1::uuid AND p.store_id = $2::uuid AND p.kind = 'pay'
           AND p.business_date = $3
       ) AS payment_cents,
       (SELECT COUNT(*)::integer
          FROM garments g INNER JOIN orders_day o
            ON o.org_id = g.org_id AND o.store_id = g.store_id AND o.id = g.order_id
         WHERE g.status = 'picked_up'
       ) AS picked_garment_count`,
    [input.orgId, input.storeId, input.businessDate],
  );
  return mapSummary(input, result.rows[0]);
}

async function queryCashSummary(
  client: SqlClient,
  input: StatsDaySummaryInput,
): Promise<Readonly<{ cash_cents: number }>> {
  const result = await client.query<Readonly<{ cash_cents: number | string }>>(
    `SELECT COALESCE(SUM(
        CASE
          WHEN p.kind = 'refund' THEN -p.amount_cents
          WHEN p.kind = 'reversal' AND referenced.kind = 'refund' THEN p.amount_cents
          WHEN p.kind = 'reversal' THEN -p.amount_cents
          ELSE p.amount_cents
        END
      ), 0)::bigint AS cash_cents
     FROM payments p
     LEFT JOIN payments referenced
       ON referenced.org_id = p.org_id
      AND referenced.store_id = p.store_id
      AND referenced.id = p.ref_payment_id
     WHERE p.org_id = $1::uuid AND p.store_id = $2::uuid
       AND p.business_date = $3 AND p.method = 'cash'`,
    [input.orgId, input.storeId, input.businessDate],
  );
  const value = result.rows[0]?.cash_cents ?? 0;
  const cashCents = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(cashCents)) throw new Error("Invalid cash aggregate from PostgreSQL");
  return Object.freeze({ cash_cents: cashCents });
}

/**
 * Read stats in SQL, reusing an active command transaction for shift closing.
 * No PG runtime stats path enumerates process-local or in-memory order rows.
 */
export function createPgStatsQuery(pool: PgPool): StatsQueryPort {
  return Object.freeze({
    daySummary: async (input: StatsDaySummaryInput): Promise<DaySummary> =>
      withStoreGucOrCurrent(pool, { orgId: input.orgId, storeId: input.storeId }, (client) =>
        queryDaySummary(client, input),
      ),
    cashSummary: async (input: StatsDaySummaryInput) =>
      withStoreGucOrCurrent(pool, { orgId: input.orgId, storeId: input.storeId }, (client) =>
        queryCashSummary(client, input),
      ),
  });
}
