/**
 * Postgres garment-photo metadata store.
 *
 * It reuses the active command transaction when called through the bus, so a
 * successful photo registration and its audit row are one atomic change.
 */

import { randomUUID } from "node:crypto";

import type { PgPool } from "../db/pg-pool.js";
import { withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import type { SqlClient } from "../db/types.js";
import type { PhotoKind, PhotoRecord, PhotoRegisterInput, PhotoStore } from "./types.js";

export type CreatePgPhotoStoreOptions = Readonly<{
  orgId: string;
  storeId: string;
  newId?: () => string;
}>;

type PhotoRow = Readonly<{
  id: string;
  org_id: string;
  store_id: string;
  garment_id: string;
  order_id: string;
  kind: string;
  storage_key: string;
  content_type: string;
  byte_size: number;
  taken_at: Date | string;
  created_by_staff_id: string;
}>;

function dateToEpoch(value: Date | string): number {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Math.floor(ms / 1000);
}

function epochToDate(value: number): Date {
  return new Date(value * 1000);
}

function asPhotoKind(value: string): PhotoKind {
  if (value === "receive" || value === "defect" || value === "ready" || value === "other") {
    return value;
  }
  throw new Error(`Unexpected garment photo kind: ${value}`);
}

function mapRow(row: PhotoRow): PhotoRecord {
  return Object.freeze({
    photo_id: row.id,
    org_id: row.org_id,
    store_id: row.store_id,
    garment_id: row.garment_id,
    order_id: row.order_id,
    kind: asPhotoKind(row.kind),
    storage_key: row.storage_key,
    content_type: row.content_type,
    byte_size: row.byte_size,
    taken_at: dateToEpoch(row.taken_at),
    created_by_staff_id: row.created_by_staff_id,
  });
}

function assertConfiguredScope(
  inputOrgId: string,
  inputStoreId: string,
  orgId: string,
  storeId: string,
): void {
  if (inputOrgId !== orgId || inputStoreId !== storeId) {
    throw new Error("Photo store scope does not match authenticated tenant");
  }
}

async function insertPhoto(
  client: SqlClient,
  input: PhotoRegisterInput,
  newId: () => string,
): Promise<PhotoRecord> {
  const id = input.photo_id ?? newId();
  const result = await client.query<PhotoRow>(
    `INSERT INTO garment_photos (
       id, org_id, store_id, garment_id, order_id, kind, storage_key,
       content_type, byte_size, taken_at, created_by_staff_id
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7,
       $8, $9, $10, $11::uuid
     )
     RETURNING id::text, org_id::text, store_id::text, garment_id::text,
               order_id::text, kind, storage_key, content_type, byte_size,
               taken_at, created_by_staff_id::text`,
    [
      id,
      input.org_id,
      input.store_id,
      input.garment_id,
      input.order_id,
      input.kind,
      input.storage_key,
      input.content_type,
      input.byte_size,
      epochToDate(input.taken_at),
      input.created_by_staff_id,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("photo registration returned no row");
  }
  return mapRow(row);
}

async function selectByOrder(
  client: SqlClient,
  orgId: string,
  storeId: string,
  orderId: string,
): Promise<readonly PhotoRecord[]> {
  const result = await client.query<PhotoRow>(
    `SELECT id::text, org_id::text, store_id::text, garment_id::text,
            order_id::text, kind, storage_key, content_type, byte_size,
            taken_at, created_by_staff_id::text
     FROM garment_photos
     WHERE org_id = $1::uuid AND store_id = $2::uuid AND order_id = $3::uuid
     ORDER BY taken_at DESC, id DESC`,
    [orgId, storeId, orderId],
  );
  return Object.freeze(result.rows.map(mapRow));
}

/** Create a tenant-scoped PG photo store; no process-memory fallback exists. */
export function createPgPhotoStore(pool: PgPool, options: CreatePgPhotoStoreOptions): PhotoStore {
  const { orgId, storeId } = options;
  const newId = options.newId ?? randomUUID;

  return Object.freeze({
    register: async (input: PhotoRegisterInput): Promise<PhotoRecord> => {
      assertConfiguredScope(input.org_id, input.store_id, orgId, storeId);
      return withStoreGucOrCurrent(
        pool,
        { orgId, storeId, staffId: input.created_by_staff_id },
        (client) => insertPhoto(client, input, newId),
      );
    },

    listByOrder: async (
      inputOrgId: string,
      inputStoreId: string,
      orderId: string,
    ): Promise<readonly PhotoRecord[]> => {
      assertConfiguredScope(inputOrgId, inputStoreId, orgId, storeId);
      return withStoreGucOrCurrent(pool, { orgId, storeId }, (client) =>
        selectByOrder(client, orgId, storeId, orderId),
      );
    },
  });
}
