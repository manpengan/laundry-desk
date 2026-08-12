import type { GarmentStatus } from "@laundry/domain";

import type { SqlClient } from "../db/types.js";
import type { FulfillmentTransitionInput } from "./types.js";

export type LockedFulfillmentGarment = Readonly<{
  garment_id: string;
  order_id: string;
  status: GarmentStatus;
  order_status: string;
  ticket_no: string;
  barcode: string;
  custody_state: string;
  active_production_batch_id: string | null;
  member_state: "active" | "exception" | "completed" | null;
  garment_purged_at: Date | string | null;
  order_purged_at: Date | string | null;
}>;

type Subject = Readonly<{
  order_id: string;
  garment_id: string;
  active_production_batch_id?: string | null;
}>;

export async function loadLockedGarmentsForLoss(
  client: SqlClient,
  input: FulfillmentTransitionInput,
): Promise<readonly LockedFulfillmentGarment[] | null> {
  const selected = await client.query<Subject>(
    `SELECT g.order_id::text, g.id::text AS garment_id,
            g.active_production_batch_id::text
       FROM garments g
      WHERE g.org_id = $1::uuid AND g.store_id = $2::uuid
        AND g.id = ANY($3::uuid[])
      ORDER BY g.id`,
    [input.org_id, input.store_id, [...input.garment_ids]],
  );
  if (selected.rows.length !== input.garment_ids.length) return null;
  const batchIds = [
    ...new Set(
      selected.rows.flatMap((row) =>
        row.active_production_batch_id === null || row.active_production_batch_id === undefined
          ? []
          : [row.active_production_batch_id],
      ),
    ),
  ].sort();
  const batchSubjects =
    batchIds.length === 0
      ? Object.freeze([])
      : (
          await client.query<Subject>(
            `SELECT bg.order_id::text, bg.garment_id::text
               FROM batch_garments bg
              WHERE bg.org_id = $1::uuid AND bg.store_id = $2::uuid
                AND bg.batch_id = ANY($3::uuid[])
              ORDER BY bg.order_id, bg.garment_id`,
            [input.org_id, input.store_id, batchIds],
          )
        ).rows;
  const subjects = [...selected.rows, ...batchSubjects];
  const orderIds = [...new Set(subjects.map((row) => row.order_id))].sort();
  const garmentIds = [...new Set(subjects.map((row) => row.garment_id))].sort();
  const orders = await client.query<
    Readonly<{ order_id: string; status: string; customer_pii_purged_at: Date | string | null }>
  >(
    `SELECT o.id::text AS order_id, o.status, o.customer_pii_purged_at
       FROM orders o
      WHERE o.org_id = $1::uuid AND o.store_id = $2::uuid
        AND o.id = ANY($3::uuid[])
      ORDER BY o.id
      FOR UPDATE`,
    [input.org_id, input.store_id, orderIds],
  );
  if (
    orders.rows.length !== orderIds.length ||
    orders.rows.some((row) => row.customer_pii_purged_at !== null)
  ) {
    return null;
  }
  const garments = await client.query<LockedFulfillmentGarment>(
    `SELECT g.id::text AS garment_id, g.order_id::text, g.status, o.status AS order_status,
            o.ticket_no, g.barcode, g.custody_state, g.active_production_batch_id::text,
            bg.state AS member_state,
            g.customer_pii_purged_at AS garment_purged_at,
            o.customer_pii_purged_at AS order_purged_at
       FROM garments g
       JOIN orders o
         ON o.org_id = g.org_id AND o.store_id = g.store_id AND o.id = g.order_id
       LEFT JOIN batch_garments bg
         ON bg.org_id = g.org_id AND bg.store_id = g.store_id
        AND bg.batch_id = g.active_production_batch_id AND bg.garment_id = g.id
      WHERE g.org_id = $1::uuid AND g.store_id = $2::uuid
        AND g.id = ANY($3::uuid[])
      ORDER BY g.id
      FOR UPDATE OF g`,
    [input.org_id, input.store_id, garmentIds],
  );
  if (
    garments.rows.length !== garmentIds.length ||
    garments.rows.some((row) => row.order_purged_at !== null || row.garment_purged_at !== null)
  ) {
    return null;
  }
  const selectedIds = new Set(input.garment_ids);
  const selectedRows = garments.rows.filter((row) => selectedIds.has(row.garment_id));
  const currentBatchIds = new Set(
    selectedRows.flatMap((row) =>
      row.active_production_batch_id === null ? [] : [row.active_production_batch_id],
    ),
  );
  if ([...currentBatchIds].some((batchId) => !batchIds.includes(batchId))) return null;
  if (batchIds.length > 0) {
    const batches = await client.query(
      `SELECT pb.id
         FROM production_batches pb
        WHERE pb.org_id = $1::uuid AND pb.store_id = $2::uuid
          AND pb.id = ANY($3::uuid[])
        ORDER BY pb.id
        FOR UPDATE`,
      [input.org_id, input.store_id, batchIds],
    );
    if ((batches.rowCount ?? batches.rows.length) !== batchIds.length) return null;
  }
  return Object.freeze(selectedRows);
}
