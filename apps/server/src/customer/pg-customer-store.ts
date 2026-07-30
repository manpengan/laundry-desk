import { randomUUID } from "node:crypto";

import type { PgPool } from "../db/pg-pool.js";
import { withOrgGucOrCurrent, withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import type { SqlClient } from "../db/types.js";
import { createPgCustomerPrivacyOperations } from "./pg-customer-privacy-store.js";
import type {
  CustomerMergeInput,
  CustomerMergeResult,
  CustomerRecord,
  CustomerSearchRow,
  CustomerStore,
  CustomerUpsertInput,
  CustomerUpsertOutcome,
  CustomerUpdateInput,
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
  merged_into_id?: string | null;
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
    merged_into_id: row.merged_into_id ?? null,
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
  client: SqlClient,
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
       WHERE org_id = $1::uuid AND merged_into_id IS NULL AND anonymized_at IS NULL
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
     WHERE org_id = $1::uuid AND merged_into_id IS NULL AND anonymized_at IS NULL
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
  client: SqlClient,
  orgId: string,
  phone: string,
): Promise<CustomerRecord | null> {
  const result = await client.query<CustomerRow>(
    `SELECT CASE WHEN source.merged_into_id IS NULL THEN source.id ELSE target.id END AS id,
            CASE WHEN source.merged_into_id IS NULL THEN source.phone ELSE target.phone END AS phone,
            CASE WHEN source.merged_into_id IS NULL THEN source.name ELSE target.name END AS name,
            CASE WHEN source.merged_into_id IS NULL THEN source.note ELSE target.note END AS note,
            CASE WHEN source.merged_into_id IS NULL
              THEN source.created_at ELSE target.created_at END AS created_at,
            CASE WHEN source.merged_into_id IS NULL
              THEN source.updated_at ELSE target.updated_at END AS updated_at,
            CASE WHEN source.merged_into_id IS NULL
              THEN source.merged_into_id ELSE target.merged_into_id END AS merged_into_id
     FROM customers source
     LEFT JOIN customers target
       ON target.org_id = source.org_id AND target.id = source.merged_into_id
     WHERE source.org_id = $1::uuid AND source.phone = $2
       AND source.anonymized_at IS NULL
     LIMIT 1`,
    [orgId, phone],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapRecord(row);
}

async function getByIdRow(
  client: SqlClient,
  orgId: string,
  customerId: string,
): Promise<CustomerRecord | null> {
  const result = await client.query<CustomerRow>(
    `SELECT id, phone, name, note, created_at, updated_at, merged_into_id
       FROM customers
      WHERE org_id = $1::uuid AND id = $2::uuid
        AND merged_into_id IS NULL AND anonymized_at IS NULL
      LIMIT 1`,
    [orgId, customerId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapRecord(row);
}

async function resolveMergeRedirect(
  client: SqlClient,
  orgId: string,
  phone: string,
): Promise<string | null> {
  const result = await client.query<Readonly<{ merged_into_id: string | null }>>(
    `SELECT merged_into_id::text
       FROM customers
      WHERE org_id = $1::uuid AND phone = $2 AND anonymized_at IS NULL
      LIMIT 1`,
    [orgId, phone],
  );
  return result.rows[0]?.merged_into_id ?? null;
}

async function upsertRow(
  client: SqlClient,
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
  const redirectedId = await resolveMergeRedirect(client, orgId, input.phone);
  if (redirectedId !== null) {
    const redirected = await client.query<CustomerRow>(
      `UPDATE customers
          SET name = CASE WHEN $4::boolean THEN $3 ELSE name END,
              note = CASE WHEN $6::boolean THEN $5 ELSE note END,
              updated_at = $7
        WHERE org_id = $1::uuid AND id = $2::uuid
          AND merged_into_id IS NULL AND anonymized_at IS NULL
        RETURNING id, phone, name, note, created_at, updated_at, merged_into_id`,
      [orgId, redirectedId, name, updateName, note, updateNote, at],
    );
    const target = redirected.rows[0];
    if (target === undefined) throw new Error("customer merge redirect target is unavailable");
    return Object.freeze({ customer: mapRecord(target), created: false });
  }

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
       id, phone, name, note, created_at, updated_at, merged_into_id,
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

async function updateRow(
  client: SqlClient,
  orgId: string,
  input: CustomerUpdateInput,
): Promise<CustomerRecord | null> {
  try {
    const result = await client.query<CustomerRow>(
      `UPDATE customers
        SET phone = CASE WHEN $4::boolean THEN $3 ELSE phone END,
            name = CASE WHEN $6::boolean THEN $5 ELSE name END,
            note = CASE WHEN $8::boolean THEN $7 ELSE note END,
            updated_at = $9
      WHERE org_id = $1::uuid AND id = $2::uuid
        AND merged_into_id IS NULL AND anonymized_at IS NULL
      RETURNING id, phone, name, note, created_at, updated_at, merged_into_id`,
      [
        orgId,
        input.customer_id,
        input.phone ?? null,
        input.phone !== undefined,
        input.name ?? null,
        input.name !== undefined,
        input.note ?? null,
        input.note !== undefined,
        epochToDate(input.now),
      ],
    );
    const row = result.rows[0];
    return row === undefined ? null : mapRecord(row);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      return null;
    }
    throw error;
  }
}

async function mergeRows(
  client: SqlClient,
  orgId: string,
  input: CustomerMergeInput,
): Promise<CustomerMergeResult | null> {
  const result = await client.query<CustomerRow>(
    `SELECT id, phone, name, note, created_at, updated_at, merged_into_id
       FROM customers
      WHERE org_id = $1::uuid AND id = ANY($2::uuid[])
      ORDER BY id
      FOR UPDATE`,
    [orgId, [input.source_customer_id, input.target_customer_id]],
  );
  const source = result.rows.find((row) => row.id === input.source_customer_id);
  const target = result.rows.find((row) => row.id === input.target_customer_id);
  if (
    source === undefined ||
    target === undefined ||
    source.id === target.id ||
    source.merged_into_id != null ||
    target.merged_into_id != null
  ) {
    return null;
  }
  const relinked = await client.query(
    `UPDATE orders
        SET customer_id = $4::uuid, customer_phone = $5,
            customer_name = COALESCE($6, customer_name), updated_at = $7
      WHERE org_id = $1::uuid AND store_id = $2::uuid
        AND customer_id = $3::uuid
        AND customer_id <> $4::uuid`,
    [
      orgId,
      input.store_id,
      source.id,
      target.id,
      target.phone,
      target.name,
      epochToDate(input.now),
    ],
  );
  await client.query(
    `UPDATE customers
        SET merged_into_id = $3::uuid, merged_at = $4, updated_at = $4
      WHERE org_id = $1::uuid AND id = $2::uuid AND merged_into_id IS NULL`,
    [orgId, source.id, target.id, epochToDate(input.now)],
  );
  return Object.freeze({
    source_customer_id: source.id,
    target_customer_id: target.id,
    relinked_order_count: relinked.rowCount ?? 0,
  });
}

async function findDuplicateRows(
  client: SqlClient,
  orgId: string,
  customerId: string,
  limit: number,
): Promise<readonly CustomerSearchRow[]> {
  const result = await client.query<CustomerRow>(
    `SELECT candidate.id, candidate.phone, candidate.name, candidate.note,
            candidate.created_at, candidate.updated_at, candidate.merged_into_id
       FROM customers source
       JOIN customers candidate
         ON candidate.org_id = source.org_id
        AND candidate.id <> source.id
        AND candidate.merged_into_id IS NULL
        AND candidate.anonymized_at IS NULL
        AND source.name IS NOT NULL
        AND lower(btrim(candidate.name)) = lower(btrim(source.name))
      WHERE source.org_id = $1::uuid AND source.id = $2::uuid
        AND source.merged_into_id IS NULL
        AND source.anonymized_at IS NULL
      ORDER BY candidate.updated_at DESC
      LIMIT $3`,
    [orgId, customerId, Math.min(limit, 20)],
  );
  return Object.freeze(result.rows.map(mapSearchRow));
}

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
      withOrgGucOrCurrent(pool, { orgId }, async (client) =>
        searchRows(client, orgId, typeof query === "string" ? query : "", limit),
      ),

    getByPhone: async (phone: string): Promise<CustomerRecord | null> =>
      withOrgGucOrCurrent(pool, { orgId }, async (client) => getByPhoneRow(client, orgId, phone)),

    getById: async (customerId: string): Promise<CustomerRecord | null> =>
      withOrgGucOrCurrent(pool, { orgId }, async (client) => getByIdRow(client, orgId, customerId)),

    upsert: async (input: CustomerUpsertInput): Promise<CustomerUpsertOutcome> =>
      withOrgGucOrCurrent(pool, { orgId }, async (client) =>
        upsertRow(client, orgId, input, newId),
      ),

    update: async (input: CustomerUpdateInput): Promise<CustomerRecord | null> =>
      withOrgGucOrCurrent(pool, { orgId }, async (client) => updateRow(client, orgId, input)),

    merge: async (input: CustomerMergeInput): Promise<CustomerMergeResult | null> =>
      withStoreGucOrCurrent(pool, { orgId, storeId: input.store_id }, async (client) =>
        mergeRows(client, orgId, input),
      ),

    findDuplicates: async (
      customerId: string,
      limit: number,
    ): Promise<readonly CustomerSearchRow[]> =>
      withOrgGucOrCurrent(pool, { orgId }, async (client) =>
        findDuplicateRows(client, orgId, customerId, limit),
      ),
    ...createPgCustomerPrivacyOperations(pool, orgId),
  });
}
