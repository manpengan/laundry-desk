/**
 * Postgres CustomerStore: laundry_app + withOrgGuc (app.org_id only).
 * Table: customers (0011). Org-scoped one profile per phone.
 */

import { randomUUID } from "node:crypto";

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
import { withOrgGuc } from "../db/tenant-guc-client.js";
import type {
  CustomerRecord,
  CustomerSearchRow,
  CustomerStore,
  CustomerUpsertInput,
  CustomerUpsertOutcome,
} from "./types.js";

export type CreatePgCustomerStoreOptions = Readonly<{
  orgId: string;
  /** Override UUID generation (tests). */
  newId?: () => string;
}>;

type CustomerRow = Readonly<{
  id: string;
  phone: string;
  name: string | null;
  note: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  created?: boolean;
}>;

function dateToEpoch(value: Date | string): number {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Math.floor(ms / 1000);
}

function epochToDate(epoch: number): Date {
  return new Date(epoch * 1000);
}

function mapRecord(row: CustomerRow): CustomerRecord {
  return Object.freeze({
    customer_id: row.id,
    phone: row.phone,
    name: row.name,
    note: row.note,
    created_at: dateToEpoch(row.created_at),
    updated_at: dateToEpoch(row.updated_at),
  });
}

function mapSearchRow(row: CustomerRow): CustomerSearchRow {
  return Object.freeze({
    customer_id: row.id,
    phone: row.phone,
    name: row.name,
    note: row.note,
    updated_at: dateToEpoch(row.updated_at),
  });
}

async function searchRows(
  client: PgPoolClient,
  orgId: string,
  query: string,
  limit: number,
): Promise<readonly CustomerSearchRow[]> {
  const capped = Math.max(0, Math.min(limit, 50));
  if (capped === 0) return Object.freeze([]);

  const q = query.trim();
  if (q.length === 0) {
    const result = await client.query<CustomerRow>(
      `SELECT id, phone, name, note, created_at, updated_at
       FROM customers
       WHERE org_id = $1::uuid
       ORDER BY updated_at DESC
       LIMIT $2`,
      [orgId, capped],
    );
    return Object.freeze(result.rows.map(mapSearchRow));
  }

  const contains = `%${q}%`;
  const result = await client.query<CustomerRow>(
    `SELECT id, phone, name, note, created_at, updated_at
     FROM customers
     WHERE org_id = $1::uuid
       AND (
         phone LIKE $2
         OR phone ILIKE $3
         OR (name IS NOT NULL AND name ILIKE $3)
       )
     ORDER BY updated_at DESC
     LIMIT $4`,
    [orgId, `${q}%`, contains, capped],
  );
  return Object.freeze(result.rows.map(mapSearchRow));
}

async function getByPhoneRow(
  client: PgPoolClient,
  orgId: string,
  phone: string,
): Promise<CustomerRecord | null> {
  const result = await client.query<CustomerRow>(
    `SELECT id, phone, name, note, created_at, updated_at
     FROM customers
     WHERE org_id = $1::uuid AND phone = $2
     LIMIT 1`,
    [orgId, phone],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapRecord(row);
}

async function upsertRow(
  client: PgPoolClient,
  orgId: string,
  input: CustomerUpsertInput,
  newId: () => string,
): Promise<CustomerUpsertOutcome> {
  const nowEpoch = input.now ?? Math.floor(Date.now() / 1000);
  const at = epochToDate(nowEpoch);
  const updateName = input.name !== undefined;
  const updateNote = input.note !== undefined;
  const name = input.name ?? null;
  const note = input.note ?? null;
  const id = input.customer_id ?? newId();

  type UpsertRow = CustomerRow & { was_inserted: boolean };
  const result = await client.query<UpsertRow>(
    `INSERT INTO customers (
       id, org_id, phone, name, note, created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5, $6, $6
     )
     ON CONFLICT (org_id, phone) DO UPDATE SET
       name = CASE WHEN $7::boolean THEN EXCLUDED.name ELSE customers.name END,
       note = CASE WHEN $8::boolean THEN EXCLUDED.note ELSE customers.note END,
       updated_at = EXCLUDED.updated_at
     RETURNING
       id, phone, name, note, created_at, updated_at,
       (xmax = 0) AS was_inserted`,
    [id, orgId, input.phone, name, note, at, updateName, updateNote],
  );

  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("customer upsert returned no row");
  }

  return Object.freeze({
    customer: mapRecord(row),
    created: row.was_inserted === true,
  });
}

/**
 * Create a CustomerStore backed by Postgres under laundry_app org RLS GUC.
 */
export function createPgCustomerStore(
  pool: PgPool,
  options: CreatePgCustomerStoreOptions,
): CustomerStore {
  const { orgId } = options;
  const newId = options.newId ?? randomUUID;

  return Object.freeze({
    search: async (
      query: string | undefined,
      limit: number,
    ): Promise<readonly CustomerSearchRow[]> =>
      withOrgGuc(pool, { orgId }, async (client) =>
        searchRows(client, orgId, typeof query === "string" ? query : "", limit),
      ),

    getByPhone: async (phone: string): Promise<CustomerRecord | null> =>
      withOrgGuc(pool, { orgId }, async (client) => getByPhoneRow(client, orgId, phone)),

    upsert: async (input: CustomerUpsertInput): Promise<CustomerUpsertOutcome> =>
      withOrgGuc(pool, { orgId }, async (client) => upsertRow(client, orgId, input, newId)),
  });
}
