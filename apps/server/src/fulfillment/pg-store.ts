import { canTransition, type GarmentStatus } from "@laundry/domain";
import { randomUUID } from "node:crypto";

import type { PgPool } from "../db/pg-pool.js";
import { withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import type { SqlClient } from "../db/types.js";
import type {
  FulfillmentIncidentInput,
  FulfillmentIncidentResult,
  FulfillmentStore,
  FulfillmentTransitionInput,
  FulfillmentTransitionRow,
  FulfillmentWorkbenchOptions,
  FulfillmentWorkbenchRow,
} from "./types.js";

type LockedGarmentRow = Readonly<{
  garment_id: string;
  order_id: string;
  status: GarmentStatus;
  order_status: string;
}>;

type WorkbenchSqlRow = Readonly<{
  garment_id: string;
  order_id: string;
  ticket_no: string;
  barcode: string;
  customer_name: string | null;
  customer_phone: string | null;
  service_code: string;
  category_code: string;
  color: string | null;
  brand: string | null;
  status: GarmentStatus;
  updated_at: Date | string;
  incident_count: number;
}>;

const toEpoch = (value: Date | string): number =>
  Math.floor((value instanceof Date ? value.getTime() : new Date(value).getTime()) / 1000);
const toDate = (epoch: number): Date => new Date(epoch * 1000);
const maskPhone = (phone: string | null): string | null =>
  phone === null ? null : `${phone.slice(0, 3)}****${phone.slice(-4)}`;
const escapeLike = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");

async function loadLockedGarments(
  client: SqlClient,
  input: FulfillmentTransitionInput,
): Promise<readonly LockedGarmentRow[]> {
  const result = await client.query<LockedGarmentRow>(
    `SELECT g.id::text AS garment_id, g.order_id::text, g.status, o.status AS order_status
       FROM garments g
       JOIN orders o
         ON o.org_id = g.org_id AND o.store_id = g.store_id AND o.id = g.order_id
      WHERE g.org_id = $1::uuid AND g.store_id = $2::uuid
        AND g.id = ANY($3::uuid[])
      ORDER BY g.id
      FOR UPDATE OF g, o`,
    [input.org_id, input.store_id, [...input.garment_ids]],
  );
  return Object.freeze(result.rows);
}

async function insertStatusLog(
  client: SqlClient,
  input: FulfillmentTransitionInput,
  row: LockedGarmentRow,
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
  row: LockedGarmentRow,
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

async function transitionRows(
  client: SqlClient,
  input: FulfillmentTransitionInput,
  newId: () => string,
): Promise<readonly FulfillmentTransitionRow[] | null> {
  const uniqueIds = new Set(input.garment_ids);
  if (uniqueIds.size !== input.garment_ids.length) return null;
  const rows = await loadLockedGarments(client, input);
  if (
    rows.length !== input.garment_ids.length ||
    rows.some(
      (row) => row.order_status !== "open" || !canTransition(row.status, input.target_status),
    )
  ) {
    return null;
  }
  await client.query(
    `UPDATE garments
        SET status = $4
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = ANY($3::uuid[])`,
    [input.org_id, input.store_id, [...input.garment_ids], input.target_status],
  );
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

async function recordIncidentRow(
  client: SqlClient,
  input: FulfillmentIncidentInput,
  newId: () => string,
): Promise<FulfillmentIncidentResult | null> {
  const lookup = await client.query<Readonly<{ order_id: string; status: GarmentStatus }>>(
    `SELECT g.order_id::text, g.status
       FROM garments g
       JOIN orders o
         ON o.org_id = g.org_id AND o.store_id = g.store_id AND o.id = g.order_id
      WHERE g.org_id = $1::uuid AND g.store_id = $2::uuid AND g.id = $3::uuid
        AND o.status = 'open'
      LIMIT 1 FOR UPDATE OF g`,
    [input.org_id, input.store_id, input.garment_id],
  );
  const garment = lookup.rows[0];
  if (
    garment === undefined ||
    garment.status === "picked_up" ||
    garment.status === "delivered" ||
    garment.status === "lost"
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

async function listWorkbenchRows(
  client: SqlClient,
  orgId: string,
  storeId: string,
  options: FulfillmentWorkbenchOptions,
): Promise<readonly FulfillmentWorkbenchRow[]> {
  const key = options.key === undefined ? null : `%${escapeLike(options.key.trim())}%`;
  const result = await client.query<WorkbenchSqlRow>(
    `SELECT g.id::text AS garment_id, g.order_id::text, o.ticket_no, g.barcode,
            o.customer_name, o.customer_phone, g.service_code, g.category_code,
            g.color, g.brand, g.status,
            COALESCE(log.latest_at, o.updated_at) AS updated_at,
            COALESCE(incident.incident_count, 0)::integer AS incident_count
       FROM garments g
       JOIN orders o
         ON o.org_id = g.org_id AND o.store_id = g.store_id AND o.id = g.order_id
       LEFT JOIN LATERAL (
         SELECT MAX(at) AS latest_at FROM garment_status_log
          WHERE org_id = g.org_id AND store_id = g.store_id AND garment_id = g.id
       ) log ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::integer AS incident_count FROM garment_incidents
          WHERE org_id = g.org_id AND store_id = g.store_id AND garment_id = g.id
       ) incident ON true
      WHERE g.org_id = $1::uuid AND g.store_id = $2::uuid
        AND ($3::text[] IS NULL OR g.status = ANY($3::text[]))
        AND (
          $4::text IS NULL OR o.ticket_no ILIKE $4 ESCAPE '\\'
          OR g.barcode ILIKE $4 ESCAPE '\\'
          OR o.customer_phone LIKE $4 ESCAPE '\\'
          OR o.customer_name ILIKE $4 ESCAPE '\\'
        )
      ORDER BY updated_at DESC, g.id
      LIMIT $5`,
    [orgId, storeId, options.statuses ?? null, key, options.limit],
  );
  return Object.freeze(
    result.rows.map((row) =>
      Object.freeze({
        garment_id: row.garment_id,
        order_id: row.order_id,
        ticket_no: row.ticket_no,
        barcode: row.barcode,
        customer_name: row.customer_name,
        customer_phone_masked: maskPhone(row.customer_phone),
        service_code: row.service_code,
        category_code: row.category_code,
        color: row.color,
        brand: row.brand,
        status: row.status,
        updated_at: toEpoch(row.updated_at),
        incident_count: row.incident_count,
      }),
    ),
  );
}

export function createPgFulfillmentStore(
  pool: PgPool,
  newId: () => string = randomUUID,
): FulfillmentStore {
  return Object.freeze({
    transition: async (input) =>
      withStoreGucOrCurrent(
        pool,
        { orgId: input.org_id, storeId: input.store_id, staffId: input.staff_id },
        (client) => transitionRows(client, input, newId),
      ),
    recordIncident: async (input) =>
      withStoreGucOrCurrent(
        pool,
        { orgId: input.org_id, storeId: input.store_id, staffId: input.staff_id },
        (client) => recordIncidentRow(client, input, newId),
      ),
    listWorkbench: async (orgId, storeId, options) =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, (client) =>
        listWorkbenchRows(client, orgId, storeId, options),
      ),
  });
}
