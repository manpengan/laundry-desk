import type { SqlClient } from "../db/types.js";
import { canTransition, type GarmentStatus } from "@laundry/domain";
import { fulfillmentConfirmationSummary } from "./factory-manifest.js";
import type {
  FulfillmentConfirmationRequest,
  FulfillmentOperationConfirmationSummary,
} from "./types.js";

type ConfirmationRow = Readonly<{
  garment_id: string;
  order_id: string;
  ticket_no: string;
  barcode: string;
  status: GarmentStatus;
  custody_state: string;
  active_production_batch_id: string | null;
  member_state: "active" | "exception" | "completed" | null;
  order_status: string;
  order_purged_at: Date | string | null;
  garment_purged_at: Date | string | null;
}>;

export async function preparePgFulfillmentConfirmation(
  client: SqlClient,
  request: FulfillmentConfirmationRequest,
): Promise<FulfillmentOperationConfirmationSummary | null> {
  const uniqueIds = [...new Set(request.garment_ids)].sort();
  if (uniqueIds.length !== request.garment_ids.length) return null;
  const related = await client.query<Readonly<{ order_id: string }>>(
    `SELECT DISTINCT g.order_id::text AS order_id
       FROM garments g
      WHERE g.org_id = $1::uuid AND g.store_id = $2::uuid
        AND g.id = ANY($3::uuid[])
      ORDER BY order_id`,
    [request.org_id, request.store_id, uniqueIds],
  );
  const orderIds = related.rows.map((row) => row.order_id);
  const orders = await client.query<
    Readonly<{ order_id: string; status: string; customer_pii_purged_at: Date | string | null }>
  >(
    `SELECT o.id::text AS order_id, o.status, o.customer_pii_purged_at
       FROM orders o
      WHERE o.org_id = $1::uuid AND o.store_id = $2::uuid AND o.id = ANY($3::uuid[])
      ORDER BY o.id
      FOR UPDATE`,
    [request.org_id, request.store_id, orderIds],
  );
  if (
    orders.rows.length !== orderIds.length ||
    orders.rows.some((row) => row.status !== "open" || row.customer_pii_purged_at !== null)
  ) {
    return null;
  }
  const rows = await client.query<ConfirmationRow>(
    `SELECT g.id::text AS garment_id, g.order_id::text, o.ticket_no, g.barcode,
            g.status, g.custody_state, g.active_production_batch_id::text,
            bg.state AS member_state,
            o.status AS order_status, o.customer_pii_purged_at AS order_purged_at,
            g.customer_pii_purged_at AS garment_purged_at
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
    [request.org_id, request.store_id, uniqueIds],
  );
  if (
    rows.rows.length !== uniqueIds.length ||
    rows.rows.some(
      (row) =>
        row.order_status !== "open" ||
        row.order_purged_at !== null ||
        row.garment_purged_at !== null ||
        (request.operation === "mark_lost" &&
          row.active_production_batch_id !== null &&
          (row.member_state !== "exception" || row.custody_state !== "exception")) ||
        (request.operation !== "mark_lost" &&
          (row.custody_state !== "store" || row.active_production_batch_id !== null)) ||
        (request.operation === "incident_record"
          ? ["picked_up", "delivered", "lost"].includes(row.status)
          : !canTransition(
              row.status,
              request.operation === "bulk_transition"
                ? request.target_status!
                : request.operation === "rework"
                  ? "reworked"
                  : "lost",
            )),
    )
  ) {
    return null;
  }
  return fulfillmentConfirmationSummary(request, rows.rows);
}
