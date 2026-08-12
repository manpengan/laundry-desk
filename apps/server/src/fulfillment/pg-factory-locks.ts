import type { GarmentStatus } from "@laundry/domain";

import type { SqlClient } from "../db/types.js";
import type {
  FactoryBatchStatus,
  FactoryCustodyState,
  FactoryMemberState,
  FactoryQcStatus,
} from "./factory-types.js";

export type PgFactoryScope = Readonly<{ org_id: string; store_id: string }>;

export type PgLockedFactoryGarment = Readonly<{
  garment_id: string;
  order_id: string;
  ticket_no: string;
  barcode: string;
  status: GarmentStatus;
  custody_state: FactoryCustodyState;
  active_production_batch_id: string | null;
  garment_purged_at: Date | string | null;
  order_status: string;
  order_purged_at: Date | string | null;
  member_state?: FactoryMemberState;
  qc_status?: FactoryQcStatus;
}>;

export type PgLockedFactoryBatch = Readonly<{
  batch_id: string;
  factory_code: string;
  status: FactoryBatchStatus;
  version: number;
  expected_garment_count: number;
  exception_garment_count: number;
}>;

export type PgLockedBatchGraph = Readonly<{
  batch: PgLockedFactoryBatch;
  garments: readonly PgLockedFactoryGarment[];
}>;

function hasValidFactoryAnchor(row: PgLockedFactoryGarment, batchId: string): boolean {
  if (row.member_state === "active") return row.active_production_batch_id === batchId;
  if (row.member_state === "completed") {
    return row.active_production_batch_id === null && row.custody_state === "store";
  }
  return (
    row.custody_state === "exception" &&
    (row.active_production_batch_id === batchId ||
      (row.active_production_batch_id === null && row.status === "lost"))
  );
}

async function lockOrders(
  client: SqlClient,
  scope: PgFactoryScope,
  orderIds: readonly string[],
  requireOpen: boolean,
): Promise<boolean> {
  if (orderIds.length === 0) return false;
  const locked = await client.query<
    Readonly<{ order_id: string; status: string; customer_pii_purged_at: Date | string | null }>
  >(
    `SELECT o.id::text AS order_id, o.status, o.customer_pii_purged_at
       FROM orders o
      WHERE o.org_id = $1::uuid AND o.store_id = $2::uuid
        AND o.id = ANY($3::uuid[])
      ORDER BY o.id
      FOR UPDATE`,
    [scope.org_id, scope.store_id, [...orderIds]],
  );
  return (
    locked.rows.length === orderIds.length &&
    locked.rows.every(
      (row) => (!requireOpen || row.status === "open") && row.customer_pii_purged_at === null,
    )
  );
}

export async function lockFactoryCreateGarments(
  client: SqlClient,
  scope: PgFactoryScope,
  garmentIds: readonly string[],
): Promise<readonly PgLockedFactoryGarment[] | null> {
  const uniqueIds = [...new Set(garmentIds)].sort();
  if (uniqueIds.length !== garmentIds.length) return null;
  const related = await client.query<Readonly<{ order_id: string }>>(
    `SELECT DISTINCT g.order_id::text
       FROM garments g
      WHERE g.org_id = $1::uuid AND g.store_id = $2::uuid
        AND g.id = ANY($3::uuid[])
      ORDER BY g.order_id::text`,
    [scope.org_id, scope.store_id, uniqueIds],
  );
  const orderIds = related.rows.map((row) => row.order_id);
  if (!(await lockOrders(client, scope, orderIds, true))) return null;
  const locked = await client.query<PgLockedFactoryGarment>(
    `SELECT g.id::text AS garment_id, g.order_id::text, o.ticket_no, g.barcode,
            g.status, g.custody_state, g.active_production_batch_id::text,
            g.customer_pii_purged_at AS garment_purged_at,
            o.status AS order_status, o.customer_pii_purged_at AS order_purged_at
       FROM garments g
       JOIN orders o
         ON o.org_id = g.org_id AND o.store_id = g.store_id AND o.id = g.order_id
      WHERE g.org_id = $1::uuid AND g.store_id = $2::uuid
        AND g.id = ANY($3::uuid[])
      ORDER BY g.id
      FOR UPDATE OF g`,
    [scope.org_id, scope.store_id, uniqueIds],
  );
  if (
    locked.rows.length !== uniqueIds.length ||
    locked.rows.some(
      (row) =>
        row.order_status !== "open" ||
        row.order_purged_at !== null ||
        row.garment_purged_at !== null,
    )
  ) {
    return null;
  }
  return Object.freeze(locked.rows);
}

export async function lockFactoryBatchGraph(
  client: SqlClient,
  scope: PgFactoryScope,
  batchId: string,
): Promise<PgLockedBatchGraph | null> {
  const related = await client.query<Readonly<{ order_id: string }>>(
    `SELECT DISTINCT bg.order_id::text
       FROM batch_garments bg
      WHERE bg.org_id = $1::uuid AND bg.store_id = $2::uuid
        AND bg.batch_id = $3::uuid
      ORDER BY bg.order_id::text`,
    [scope.org_id, scope.store_id, batchId],
  );
  const orderIds = related.rows.map((row) => row.order_id);
  if (!(await lockOrders(client, scope, orderIds, false))) return null;
  const garments = await client.query<PgLockedFactoryGarment>(
    `SELECT g.id::text AS garment_id, g.order_id::text, o.ticket_no, g.barcode,
            g.status, g.custody_state, g.active_production_batch_id::text,
            g.customer_pii_purged_at AS garment_purged_at,
            o.status AS order_status, o.customer_pii_purged_at AS order_purged_at,
            bg.state AS member_state, bg.qc_status
       FROM batch_garments bg
       JOIN garments g
         ON g.org_id = bg.org_id AND g.store_id = bg.store_id AND g.id = bg.garment_id
       JOIN orders o
         ON o.org_id = g.org_id AND o.store_id = g.store_id AND o.id = g.order_id
      WHERE bg.org_id = $1::uuid AND bg.store_id = $2::uuid
        AND bg.batch_id = $3::uuid
      ORDER BY g.id
      FOR UPDATE OF g`,
    [scope.org_id, scope.store_id, batchId],
  );
  const batch = await client.query<PgLockedFactoryBatch>(
    `SELECT id::text AS batch_id, factory_code, status, version,
            expected_garment_count, exception_garment_count
       FROM production_batches
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      FOR UPDATE`,
    [scope.org_id, scope.store_id, batchId],
  );
  const batchRow = batch.rows[0];
  if (
    batchRow === undefined ||
    garments.rows.length !== batchRow.expected_garment_count ||
    garments.rows.some(
      (row) =>
        (row.order_status !== "open" &&
          !(
            row.member_state === "exception" &&
            row.status === "lost" &&
            row.active_production_batch_id === null
          )) ||
        row.order_purged_at !== null ||
        row.garment_purged_at !== null ||
        !hasValidFactoryAnchor(row, batchId),
    )
  ) {
    return null;
  }
  return Object.freeze({ batch: batchRow, garments: Object.freeze(garments.rows) });
}

export async function databaseNow(
  client: SqlClient,
): Promise<Readonly<{ date: Date; epoch: number }>> {
  const result = await client.query<Readonly<{ now: Date | string; epoch: number | string }>>(
    `SELECT statement_timestamp() AS now,
            floor(extract(epoch FROM statement_timestamp()))::bigint AS epoch`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("PostgreSQL did not return statement_timestamp authority");
  return Object.freeze({
    date: row.now instanceof Date ? row.now : new Date(row.now),
    epoch: Number(row.epoch),
  });
}
