import type { GarmentStatus } from "@laundry/domain";

import type { SqlClient } from "../db/types.js";
import { fulfillmentConfirmationSummary } from "./factory-manifest.js";
import type { FulfillmentIncidentInput, FulfillmentIncidentResult } from "./types.js";

const toDate = (epoch: number): Date => new Date(epoch * 1000);

export async function recordPgFulfillmentIncident(
  client: SqlClient,
  input: FulfillmentIncidentInput,
  newId: () => string,
): Promise<FulfillmentIncidentResult | null> {
  const relatedOrder = await client.query<Readonly<{ order_id: string }>>(
    `SELECT g.order_id::text
       FROM garments g
      WHERE g.org_id = $1::uuid AND g.store_id = $2::uuid AND g.id = $3::uuid
      LIMIT 1`,
    [input.org_id, input.store_id, input.garment_id],
  );
  const orderId = relatedOrder.rows[0]?.order_id;
  if (orderId === undefined) return null;
  const lockedOrder = await client.query<
    Readonly<{
      status: string;
      ticket_no: string;
      customer_pii_purged_at: Date | string | null;
    }>
  >(
    `SELECT o.status, o.ticket_no, o.customer_pii_purged_at
       FROM orders o
      WHERE o.org_id = $1::uuid AND o.store_id = $2::uuid AND o.id = $3::uuid
      FOR UPDATE`,
    [input.org_id, input.store_id, orderId],
  );
  const lockedOrderRow = lockedOrder.rows[0];
  if (lockedOrderRow?.status !== "open" || lockedOrderRow.customer_pii_purged_at !== null) {
    return null;
  }
  const lookup = await client.query<
    Readonly<{
      garment_id: string;
      order_id: string;
      status: GarmentStatus;
      barcode: string;
      custody_state: string;
      active_production_batch_id: string | null;
      garment_purged_at: Date | string | null;
    }>
  >(
    `SELECT g.id::text AS garment_id, g.order_id::text, g.status, g.barcode,
            g.custody_state, g.active_production_batch_id::text,
            g.customer_pii_purged_at AS garment_purged_at
       FROM garments g
      WHERE g.org_id = $1::uuid AND g.store_id = $2::uuid AND g.id = $3::uuid
        AND g.order_id = $4::uuid
      LIMIT 1 FOR UPDATE OF g`,
    [input.org_id, input.store_id, input.garment_id, orderId],
  );
  const garment = lookup.rows[0];
  if (
    garment === undefined ||
    garment.garment_purged_at !== null ||
    garment.custody_state !== "store" ||
    garment.active_production_batch_id !== null ||
    garment.status === "picked_up" ||
    garment.status === "delivered" ||
    garment.status === "lost"
  ) {
    return null;
  }
  const authority = fulfillmentConfirmationSummary(
    {
      operation: "incident_record",
      org_id: input.org_id,
      store_id: input.store_id,
      garment_ids: [input.garment_id],
      target_status: null,
      incident_kind: input.kind,
      compensation_cents: input.compensation_cents,
      reason: null,
      note: input.note,
    },
    [
      Object.freeze({
        garment_id: garment.garment_id,
        order_id: garment.order_id,
        ticket_no: lockedOrderRow.ticket_no,
        barcode: garment.barcode,
        status: garment.status,
        custody_state: garment.custody_state,
        active_production_batch_id: garment.active_production_batch_id,
      }),
    ],
  );
  if (
    input.expected_manifest_digest !== undefined &&
    input.expected_manifest_digest !== authority.manifest_digest
  ) {
    return null;
  }
  const incidentId = newId();
  await client.query(
    `INSERT INTO garment_incidents (
       id, org_id, store_id, order_id, garment_id, kind, note,
       compensation_cents, staff_id, created_at
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9::uuid, $10)`,
    [
      incidentId,
      input.org_id,
      input.store_id,
      garment.order_id,
      input.garment_id,
      input.kind,
      input.note,
      input.compensation_cents,
      input.staff_id,
      toDate(input.at),
    ],
  );
  return Object.freeze({
    incident_id: incidentId,
    garment_id: input.garment_id,
    order_id: garment.order_id,
    kind: input.kind,
    compensation_cents: input.compensation_cents,
    created_at: input.at,
  });
}
