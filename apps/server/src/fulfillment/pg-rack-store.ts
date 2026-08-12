import type { PgPool } from "../db/pg-pool.js";
import { withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import type { SqlClient } from "../db/types.js";
import type { FulfillmentRackAssignInput, FulfillmentRackAssignResult } from "./types.js";

type RackGarmentRow = Readonly<{
  garment_id: string;
  order_id: string;
  status: string;
  order_status: string;
  barcode: string;
  rack_zone: string | null;
  rack_slot: string | null;
  racked_at: Date | string | null;
  custody_state: string;
  active_production_batch_id: string | null;
  garment_purged_at: Date | string | null;
  order_purged_at: Date | string | null;
}>;

const toEpoch = (value: Date | string): number =>
  Math.floor((value instanceof Date ? value.getTime() : new Date(value).getTime()) / 1000);
const toDate = (epoch: number): Date => new Date(epoch * 1000);

async function assignRackRow(
  client: SqlClient,
  input: FulfillmentRackAssignInput,
  newId: () => string,
): Promise<FulfillmentRackAssignResult | null> {
  const relatedOrder = await client.query<Readonly<{ order_id: string }>>(
    `SELECT g.order_id::text
       FROM garments g
      WHERE g.org_id = $1::uuid AND g.store_id = $2::uuid
        AND upper(g.barcode) = upper($3)
      LIMIT 1`,
    [input.org_id, input.store_id, input.barcode],
  );
  const orderId = relatedOrder.rows[0]?.order_id;
  if (orderId === undefined) return null;
  const lockedOrder = await client.query<
    Readonly<{ order_status: string; customer_pii_purged_at: Date | string | null }>
  >(
    `SELECT o.status AS order_status, o.customer_pii_purged_at
       FROM orders o
      WHERE o.org_id = $1::uuid AND o.store_id = $2::uuid AND o.id = $3::uuid
      FOR UPDATE`,
    [input.org_id, input.store_id, orderId],
  );
  if (
    lockedOrder.rows[0]?.order_status !== "open" ||
    lockedOrder.rows[0]?.customer_pii_purged_at !== null
  ) {
    return null;
  }
  const result = await client.query<RackGarmentRow>(
    `SELECT g.id::text AS garment_id, g.order_id::text, g.status, o.status AS order_status,
            g.barcode, g.rack_zone, g.rack_slot, g.racked_at,
            g.custody_state, g.active_production_batch_id::text,
            g.customer_pii_purged_at AS garment_purged_at,
            o.customer_pii_purged_at AS order_purged_at
       FROM garments g
       JOIN orders o
         ON o.org_id = g.org_id AND o.store_id = g.store_id AND o.id = g.order_id
      WHERE g.org_id = $1::uuid AND g.store_id = $2::uuid
        AND upper(g.barcode) = upper($3)
        AND g.order_id = $4::uuid
      LIMIT 1
      FOR UPDATE OF g`,
    [input.org_id, input.store_id, input.barcode, orderId],
  );
  const row = result.rows[0];
  if (
    row === undefined ||
    row.order_status !== "open" ||
    row.order_purged_at !== null ||
    row.garment_purged_at !== null ||
    row.custody_state !== "store" ||
    row.active_production_batch_id !== null
  ) {
    return null;
  }
  if (
    row.status === "racked" &&
    row.rack_zone === input.rack_zone &&
    row.rack_slot === input.rack_slot &&
    row.racked_at !== null
  ) {
    return Object.freeze({
      garment_id: row.garment_id,
      order_id: row.order_id,
      barcode: row.barcode,
      rack_zone: row.rack_zone,
      rack_slot: row.rack_slot,
      status: "racked",
      racked_at: toEpoch(row.racked_at),
    });
  }
  if (row.status !== "ready") return null;

  await client.query(
    `UPDATE garments
        SET status = 'racked', rack_zone = $4, rack_slot = $5,
            racked_at = $6, racked_by_staff_id = $7::uuid
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
    [
      input.org_id,
      input.store_id,
      row.garment_id,
      input.rack_zone,
      input.rack_slot,
      toDate(input.at),
      input.staff_id,
    ],
  );
  await client.query(
    `INSERT INTO garment_status_log (
       id, org_id, store_id, order_id, garment_id,
       from_status, to_status, reason, staff_id, at
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
               'ready', 'racked', $6, $7::uuid, $8)`,
    [
      newId(),
      input.org_id,
      input.store_id,
      row.order_id,
      row.garment_id,
      `rack:${input.rack_zone}-${input.rack_slot}`,
      input.staff_id,
      toDate(input.at),
    ],
  );
  await client.query(
    `INSERT INTO garment_rack_log (
       id, org_id, store_id, order_id, garment_id, barcode,
       rack_zone, rack_slot, staff_id, at
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9::uuid, $10)`,
    [
      newId(),
      input.org_id,
      input.store_id,
      row.order_id,
      row.garment_id,
      row.barcode,
      input.rack_zone,
      input.rack_slot,
      input.staff_id,
      toDate(input.at),
    ],
  );
  return Object.freeze({
    garment_id: row.garment_id,
    order_id: row.order_id,
    barcode: row.barcode,
    rack_zone: input.rack_zone,
    rack_slot: input.rack_slot,
    status: "racked",
    racked_at: input.at,
  });
}

export async function assignPgRack(
  pool: PgPool,
  input: FulfillmentRackAssignInput,
  newId: () => string,
): Promise<FulfillmentRackAssignResult | null> {
  return withStoreGucOrCurrent(
    pool,
    { orgId: input.org_id, storeId: input.store_id, staffId: input.staff_id },
    (client) => assignRackRow(client, input, newId),
  );
}
