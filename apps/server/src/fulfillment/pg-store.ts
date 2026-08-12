import type { GarmentStatus } from "@laundry/domain";
import { randomUUID } from "node:crypto";

import type { PgPool } from "../db/pg-pool.js";
import { withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import type { SqlClient } from "../db/types.js";
import type {
  FulfillmentStore,
  FulfillmentWorkbenchOptions,
  FulfillmentWorkbenchRow,
} from "./types.js";
import { assignPgRack } from "./pg-rack-store.js";
import { preparePgFactoryConfirmation } from "./pg-factory-confirmation.js";
import { createPgFactoryBatch, cancelPgFactoryBatch } from "./pg-factory-batch-write.js";
import { recordPgFactoryCheckpoint } from "./pg-factory-checkpoint-write.js";
import { resolvePgFactoryDiscrepancy } from "./pg-factory-resolve-write.js";
import { recordPgFactoryQuality } from "./pg-factory-quality-write.js";
import { getPgFactoryBatch, listPgFactoryBatches } from "./pg-factory-read.js";
import { preparePgFulfillmentConfirmation } from "./pg-fulfillment-confirmation.js";
import { recordPgFulfillmentIncident } from "./pg-fulfillment-incident.js";
import { transitionPgGarments } from "./pg-fulfillment-transition.js";

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
  rack_zone: string | null;
  rack_slot: string | null;
  updated_at: Date | string;
  incident_count: number;
}>;

const toEpoch = (value: Date | string): number =>
  Math.floor((value instanceof Date ? value.getTime() : new Date(value).getTime()) / 1000);
const maskPhone = (phone: string | null): string | null =>
  phone === null ? null : `${phone.slice(0, 3)}****${phone.slice(-4)}`;
const escapeLike = (value: string): string =>
  value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");

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
            g.color, g.brand, g.status, g.rack_zone, g.rack_slot,
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
          OR g.rack_zone ILIKE $4 ESCAPE '\\'
          OR g.rack_slot ILIKE $4 ESCAPE '\\'
          OR concat_ws('-', g.rack_zone, g.rack_slot) ILIKE $4 ESCAPE '\\'
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
        rack_zone: row.rack_zone,
        rack_slot: row.rack_slot,
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
    prepareFulfillmentConfirmation: async (request) =>
      withStoreGucOrCurrent(pool, { orgId: request.org_id, storeId: request.store_id }, (client) =>
        preparePgFulfillmentConfirmation(client, request),
      ),
    prepareFactoryConfirmation: async (request) =>
      withStoreGucOrCurrent(
        pool,
        {
          orgId: request.input.org_id,
          storeId: request.input.store_id,
          staffId: request.input.staff_id,
        },
        (client) => preparePgFactoryConfirmation(client, request),
      ),
    createFactoryBatch: async (input) =>
      withStoreGucOrCurrent(
        pool,
        { orgId: input.org_id, storeId: input.store_id, staffId: input.staff_id },
        (client) => createPgFactoryBatch(client, input, newId),
      ),
    cancelFactoryBatch: async (input) =>
      withStoreGucOrCurrent(
        pool,
        { orgId: input.org_id, storeId: input.store_id, staffId: input.staff_id },
        (client) => cancelPgFactoryBatch(client, input),
      ),
    recordFactoryCheckpoint: async (input) =>
      withStoreGucOrCurrent(
        pool,
        { orgId: input.org_id, storeId: input.store_id, staffId: input.staff_id },
        (client) => recordPgFactoryCheckpoint(client, input, newId),
      ),
    resolveFactoryDiscrepancy: async (input) =>
      withStoreGucOrCurrent(
        pool,
        { orgId: input.org_id, storeId: input.store_id, staffId: input.staff_id },
        (client) => resolvePgFactoryDiscrepancy(client, input, newId),
      ),
    recordFactoryQuality: async (input) =>
      withStoreGucOrCurrent(
        pool,
        { orgId: input.org_id, storeId: input.store_id, staffId: input.staff_id },
        (client) => recordPgFactoryQuality(client, input, newId),
      ),
    listFactoryBatches: async (orgId, storeId, options) =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, (client) =>
        listPgFactoryBatches(client, orgId, storeId, options),
      ),
    getFactoryBatch: async (orgId, storeId, batchId) =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, (client) =>
        getPgFactoryBatch(client, orgId, storeId, batchId),
      ),
    transition: async (input) =>
      withStoreGucOrCurrent(
        pool,
        { orgId: input.org_id, storeId: input.store_id, staffId: input.staff_id },
        (client) => transitionPgGarments(client, input, newId),
      ),
    assignRack: async (input) => assignPgRack(pool, input, newId),
    recordIncident: async (input) =>
      withStoreGucOrCurrent(
        pool,
        { orgId: input.org_id, storeId: input.store_id, staffId: input.staff_id },
        (client) => recordPgFulfillmentIncident(client, input, newId),
      ),
    listWorkbench: async (orgId, storeId, options) =>
      withStoreGucOrCurrent(pool, { orgId, storeId }, (client) =>
        listWorkbenchRows(client, orgId, storeId, options),
      ),
  });
}
