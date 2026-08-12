import { canTransition } from "@laundry/domain";

import type { SqlClient } from "../db/types.js";
import { fulfillmentConfirmationSummary } from "./factory-manifest.js";
import {
  loadLockedGarmentsForLoss,
  type LockedFulfillmentGarment,
} from "./pg-fulfillment-lost-locks.js";
import type { FulfillmentTransitionInput, FulfillmentTransitionRow } from "./types.js";

const toDate = (epoch: number): Date => new Date(epoch * 1000);

async function loadLockedGarments(
  client: SqlClient,
  input: FulfillmentTransitionInput,
): Promise<readonly LockedFulfillmentGarment[]> {
  const relatedOrders = await client.query<Readonly<{ order_id: string }>>(
    `SELECT DISTINCT g.order_id::text AS order_id
       FROM garments g
      WHERE g.org_id = $1::uuid AND g.store_id = $2::uuid
        AND g.id = ANY($3::uuid[])
      ORDER BY order_id`,
    [input.org_id, input.store_id, [...input.garment_ids]],
  );
  const orderIds = relatedOrders.rows.map((row) => row.order_id);
  await client.query(
    `SELECT o.id
       FROM orders o
      WHERE o.org_id = $1::uuid AND o.store_id = $2::uuid
        AND o.id = ANY($3::uuid[])
      ORDER BY o.id
      FOR UPDATE`,
    [input.org_id, input.store_id, orderIds],
  );
  const result = await client.query<LockedFulfillmentGarment>(
    `SELECT g.id::text AS garment_id, g.order_id::text, g.status, o.status AS order_status,
            o.ticket_no, g.barcode, g.custody_state, g.active_production_batch_id::text,
            g.customer_pii_purged_at AS garment_purged_at,
            o.customer_pii_purged_at AS order_purged_at
       FROM garments g
       JOIN orders o
         ON o.org_id = g.org_id AND o.store_id = g.store_id AND o.id = g.order_id
      WHERE g.org_id = $1::uuid AND g.store_id = $2::uuid
        AND g.id = ANY($3::uuid[])
      ORDER BY g.id
      FOR UPDATE OF g`,
    [input.org_id, input.store_id, [...input.garment_ids]],
  );
  return Object.freeze(result.rows);
}

async function insertStatusLog(
  client: SqlClient,
  input: FulfillmentTransitionInput,
  row: LockedFulfillmentGarment,
  newId: () => string,
): Promise<void> {
  await client.query(
    `INSERT INTO garment_status_log (
       id, org_id, store_id, order_id, garment_id,
       from_status, to_status, reason, staff_id, at
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9::uuid, $10)`,
    [
      newId(),
      input.org_id,
      input.store_id,
      row.order_id,
      row.garment_id,
      row.status,
      input.target_status,
      input.reason,
      input.staff_id,
      toDate(input.at),
    ],
  );
}

async function insertIncident(
  client: SqlClient,
  input: FulfillmentTransitionInput,
  row: LockedFulfillmentGarment,
  newId: () => string,
): Promise<void> {
  if (input.incident === undefined) return;
  await client.query(
    `INSERT INTO garment_incidents (
       id, org_id, store_id, order_id, garment_id, kind, note,
       compensation_cents, staff_id, created_at
     ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9::uuid, $10)`,
    [
      newId(),
      input.org_id,
      input.store_id,
      row.order_id,
      row.garment_id,
      input.incident.kind,
      input.incident.note,
      input.incident.compensation_cents,
      input.staff_id,
      toDate(input.at),
    ],
  );
}

export async function transitionPgGarments(
  client: SqlClient,
  input: FulfillmentTransitionInput,
  newId: () => string,
): Promise<readonly FulfillmentTransitionRow[] | null> {
  const uniqueIds = new Set(input.garment_ids);
  if (uniqueIds.size !== input.garment_ids.length) return null;
  const rows =
    input.target_status === "lost"
      ? await loadLockedGarmentsForLoss(client, input)
      : await loadLockedGarments(client, input);
  if (rows === null) return null;
  const operation =
    input.confirmation_operation ??
    (input.target_status === "lost"
      ? "mark_lost"
      : input.target_status === "reworked"
        ? "rework"
        : "bulk_transition");
  const authority = fulfillmentConfirmationSummary(
    {
      operation,
      org_id: input.org_id,
      store_id: input.store_id,
      garment_ids: input.garment_ids,
      target_status:
        input.target_status === "washing" || input.target_status === "ready"
          ? input.target_status
          : null,
      incident_kind: null,
      compensation_cents:
        operation === "mark_lost" ? (input.incident?.compensation_cents ?? null) : null,
      reason: operation === "bulk_transition" ? null : input.reason,
      note: operation === "bulk_transition" ? (input.note ?? null) : null,
    },
    rows,
  );
  if (
    rows.length !== input.garment_ids.length ||
    rows.some(
      (row) =>
        row.order_status !== "open" ||
        row.order_purged_at !== null ||
        row.garment_purged_at !== null ||
        !canTransition(row.status, input.target_status) ||
        (input.target_status === "lost" &&
          row.active_production_batch_id !== null &&
          (row.member_state !== "exception" || row.custody_state !== "exception")) ||
        (input.target_status !== "lost" &&
          (row.custody_state !== "store" || row.active_production_batch_id !== null)),
    ) ||
    (input.expected_manifest_digest !== undefined &&
      input.expected_manifest_digest !== authority.manifest_digest)
  ) {
    return null;
  }
  const activeBatchIds = [
    ...new Set(
      rows
        .map((row) => row.active_production_batch_id)
        .filter((batchId): batchId is string => batchId !== null),
    ),
  ].sort();
  if (input.target_status === "lost" && activeBatchIds.length > 0 && input.device_id == null) {
    return null;
  }
  await client.query(
    `UPDATE garments
        SET status = $4, rack_zone = NULL, rack_slot = NULL,
            racked_at = NULL, racked_by_staff_id = NULL
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = ANY($3::uuid[])`,
    [input.org_id, input.store_id, [...input.garment_ids], input.target_status],
  );
  if (input.target_status === "lost") {
    await client.query(
      `UPDATE garments
          SET custody_state = 'exception', active_production_batch_id = NULL
        WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = ANY($3::uuid[])`,
      [input.org_id, input.store_id, [...input.garment_ids]],
    );
    await client.query(
      `UPDATE batch_garments
          SET state = 'exception', updated_by_staff_id = $4::uuid,
              updated_by_device_id = $5::uuid, updated_at = statement_timestamp()
        WHERE org_id = $1::uuid AND store_id = $2::uuid
          AND garment_id = ANY($3::uuid[]) AND state = 'exception'`,
      [input.org_id, input.store_id, [...input.garment_ids], input.staff_id, input.device_id],
    );
    if (activeBatchIds.length > 0) {
      await client.query(
        `UPDATE production_batches pb
            SET version = version + 1,
                exception_garment_count = (
                  SELECT COUNT(*)::integer FROM batch_garments bg
                   WHERE bg.org_id = pb.org_id AND bg.store_id = pb.store_id
                     AND bg.batch_id = pb.id AND bg.state = 'exception'
                ),
                updated_by_staff_id = $4::uuid,
                updated_by_device_id = $5::uuid,
                updated_at = statement_timestamp()
          WHERE pb.org_id = $1::uuid AND pb.store_id = $2::uuid
            AND pb.id = ANY($3::uuid[])
            AND pb.status NOT IN ('store_received', 'cancelled')`,
        [input.org_id, input.store_id, activeBatchIds, input.staff_id, input.device_id],
      );
    }
  }
  for (const row of rows) {
    await insertStatusLog(client, input, row, newId);
    await insertIncident(client, input, row, newId);
  }
  const orderIds = [...new Set(rows.map((row) => row.order_id))];
  await client.query(
    `UPDATE orders o
        SET status = 'closed', updated_at = $4
      WHERE o.org_id = $1::uuid AND o.store_id = $2::uuid
        AND o.id = ANY($3::uuid[]) AND o.status = 'open' AND o.balance_cents = 0
        AND NOT EXISTS (
          SELECT 1 FROM garments g
           WHERE g.org_id = o.org_id AND g.store_id = o.store_id AND g.order_id = o.id
             AND g.status NOT IN ('picked_up', 'delivered', 'lost')
        )`,
    [input.org_id, input.store_id, orderIds, toDate(input.at)],
  );
  return Object.freeze(
    rows.map((row) =>
      Object.freeze({
        garment_id: row.garment_id,
        order_id: row.order_id,
        from_status: row.status,
        to_status: input.target_status,
      }),
    ),
  );
}
