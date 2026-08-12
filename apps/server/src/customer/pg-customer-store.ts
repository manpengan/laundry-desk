import { randomUUID } from "node:crypto";

import type { PgPool } from "../db/pg-pool.js";
import { withOrgGucOrCurrent, withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import type { SqlClient } from "../db/types.js";
import { mergeCustomerRows } from "./pg-customer-merge.js";
import {
  findCustomerDuplicateRows,
  getCustomerByIdRow,
  getCustomerByPhoneRow,
  searchCustomerRows,
} from "./pg-customer-read.js";
import { createPgCustomerPrivacyOperations } from "./pg-customer-privacy-store.js";
import { CustomerErasedError } from "./types.js";
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
  version: number | string;
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
    version: Number(row.version),
    created_at: dateToEpoch(row.created_at),
    updated_at: dateToEpoch(row.updated_at),
    merged_into_id: row.merged_into_id ?? null,
  });
}

async function resolvePhoneRoot(
  client: SqlClient,
  orgId: string,
  phone: string,
): Promise<string | null> {
  const result = await client.query<Readonly<{ root_id: string | null }>>(
    `SELECT customer_canonical_root(id)::text AS root_id
       FROM customers
      WHERE org_id = $1::uuid AND phone = $2 AND anonymized_at IS NULL
      LIMIT 1`,
    [orgId, phone],
  );
  return result.rows[0]?.root_id ?? null;
}

async function assertPhoneNotErased(client: SqlClient, phone: string): Promise<void> {
  const result = await client.query<Readonly<{ erased: boolean }>>(
    "SELECT customer_phone_erased($1) AS erased",
    [phone],
  );
  if (result.rows[0]?.erased === true) throw new CustomerErasedError();
}

function isErasedDatabaseError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P0001" &&
    "message" in error &&
    error.message === "CUSTOMER_ERASED"
  );
}

async function updateCanonicalByPhone(
  client: SqlClient,
  orgId: string,
  rootId: string,
  input: CustomerUpsertInput,
  at: Date,
): Promise<CustomerUpsertOutcome> {
  const updated = await client.query<CustomerRow>(
    `UPDATE customers
        SET name = CASE WHEN $4::boolean THEN $3 ELSE name END,
            note = CASE WHEN $6::boolean THEN $5 ELSE note END,
            version = version + 1,
            updated_at = $7
      WHERE org_id = $1::uuid AND id = $2::uuid
        AND merged_into_id IS NULL AND anonymized_at IS NULL
      RETURNING id, phone, name, note, version, created_at, updated_at, merged_into_id`,
    [
      orgId,
      rootId,
      input.name ?? null,
      input.name !== undefined,
      input.note ?? null,
      input.note !== undefined,
      at,
    ],
  );
  const target = updated.rows[0];
  if (target === undefined) throw new Error("customer merge redirect target is unavailable");
  return Object.freeze({ customer: mapRecord(target), created: false });
}

async function upsertRow(
  client: SqlClient,
  orgId: string,
  input: CustomerUpsertInput,
  newId: () => string,
): Promise<CustomerUpsertOutcome> {
  const nowEpoch = input.now ?? Math.floor(Date.now() / 1000);
  const at = epochToDate(nowEpoch);
  const name = input.name ?? null;
  const note = input.note ?? null;
  const id = input.customer_id ?? newId();
  await assertPhoneNotErased(client, input.phone);
  const redirectedId = await resolvePhoneRoot(client, orgId, input.phone);
  if (redirectedId !== null) return updateCanonicalByPhone(client, orgId, redirectedId, input, at);

  const result = await client.query<CustomerRow>(
    `INSERT INTO customers (
       id, org_id, phone, name, note, version, created_at, updated_at
     ) VALUES (
       $1::uuid, $2::uuid, $3, $4, $5, 1, $6, $6
     )
     ON CONFLICT (org_id, phone) DO NOTHING
     RETURNING id, phone, name, note, version, created_at, updated_at, merged_into_id`,
    [id, orgId, input.phone, name, note, at],
  );

  const row = result.rows[0];
  if (row === undefined) {
    const racedRoot = await resolvePhoneRoot(client, orgId, input.phone);
    if (racedRoot === null) throw new Error("customer upsert conflict has no canonical row");
    return updateCanonicalByPhone(client, orgId, racedRoot, input, at);
  }

  return Object.freeze({
    customer: mapRecord(row),
    created: true,
  });
}

async function updateRow(
  client: SqlClient,
  orgId: string,
  input: CustomerUpdateInput,
): Promise<CustomerRecord | null> {
  try {
    const result =
      input.phone === undefined
        ? await updateCustomerMetadata(client, orgId, input)
        : await updateCustomerPhoneAndMetadata(client, orgId, input, input.phone);
    const row = result.rows[0];
    return row === undefined ? null : mapRecord(row);
  } catch (error) {
    if (isErasedDatabaseError(error)) throw new CustomerErasedError();
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      return null;
    }
    throw error;
  }
}

async function updateCustomerMetadata(
  client: SqlClient,
  orgId: string,
  input: CustomerUpdateInput,
) {
  return client.query<CustomerRow>(
    `UPDATE customers
        SET name = CASE WHEN $4::boolean THEN $3 ELSE name END,
            note = CASE WHEN $6::boolean THEN $5 ELSE note END,
            version = version + 1,
            updated_at = $7
      WHERE org_id = $1::uuid AND id = customer_canonical_root($2::uuid)
        AND version = $8
        AND merged_into_id IS NULL AND anonymized_at IS NULL
      RETURNING id, phone, name, note, version, created_at, updated_at, merged_into_id`,
    [
      orgId,
      input.customer_id,
      input.name ?? null,
      input.name !== undefined,
      input.note ?? null,
      input.note !== undefined,
      epochToDate(input.now),
      input.expected_version,
    ],
  );
}

async function updateCustomerPhoneAndMetadata(
  client: SqlClient,
  orgId: string,
  input: CustomerUpdateInput,
  phone: string,
) {
  await assertPhoneNotErased(client, phone);
  return client.query<CustomerRow>(
    `UPDATE customers
        SET phone = $3,
            name = CASE WHEN $5::boolean THEN $4 ELSE name END,
            note = CASE WHEN $7::boolean THEN $6 ELSE note END,
            version = version + 1,
            updated_at = $8
      WHERE org_id = $1::uuid AND id = customer_canonical_root($2::uuid)
        AND version = $9
        AND merged_into_id IS NULL AND anonymized_at IS NULL
      RETURNING id, phone, name, note, version, created_at, updated_at, merged_into_id`,
    [
      orgId,
      input.customer_id,
      phone,
      input.name ?? null,
      input.name !== undefined,
      input.note ?? null,
      input.note !== undefined,
      epochToDate(input.now),
      input.expected_version,
    ],
  );
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
        searchCustomerRows(client, orgId, typeof query === "string" ? query : "", limit),
      ),

    getByPhone: async (phone: string): Promise<CustomerRecord | null> =>
      withOrgGucOrCurrent(pool, { orgId }, async (client) =>
        getCustomerByPhoneRow(client, orgId, phone),
      ),

    getById: async (customerId: string): Promise<CustomerRecord | null> =>
      withOrgGucOrCurrent(pool, { orgId }, async (client) =>
        getCustomerByIdRow(client, orgId, customerId),
      ),

    resolveCanonicalId: async (customerId: string): Promise<string | null> =>
      withOrgGucOrCurrent(pool, { orgId }, async (client) => {
        const result = await client.query<Readonly<{ root_id: string | null }>>(
          "SELECT customer_canonical_root($1::uuid)::text AS root_id",
          [customerId],
        );
        return result.rows[0]?.root_id ?? null;
      }),

    listCanonicalGroup: async (customerId: string): Promise<readonly string[]> =>
      withOrgGucOrCurrent(pool, { orgId }, async (client) => {
        const result = await client.query<Readonly<{ group_customer_id: string }>>(
          "SELECT group_customer_id::text FROM customer_canonical_group($1::uuid)",
          [customerId],
        );
        return Object.freeze(result.rows.map((row) => row.group_customer_id));
      }),

    upsert: async (input: CustomerUpsertInput): Promise<CustomerUpsertOutcome> =>
      withOrgGucOrCurrent(pool, { orgId }, async (client) => {
        try {
          return await upsertRow(client, orgId, input, newId);
        } catch (error) {
          if (isErasedDatabaseError(error)) throw new CustomerErasedError();
          throw error;
        }
      }),

    update: async (input: CustomerUpdateInput): Promise<CustomerRecord | null> =>
      withOrgGucOrCurrent(pool, { orgId }, async (client) => updateRow(client, orgId, input)),

    merge: async (input: CustomerMergeInput): Promise<CustomerMergeResult | null> =>
      withStoreGucOrCurrent(
        pool,
        { orgId, storeId: input.store_id, staffId: input.staff_id },
        async (client) => mergeCustomerRows(client, orgId, input),
      ),

    findDuplicates: async (
      customerId: string,
      limit: number,
    ): Promise<readonly CustomerSearchRow[]> =>
      withOrgGucOrCurrent(pool, { orgId }, async (client) =>
        findCustomerDuplicateRows(client, orgId, customerId, limit),
      ),
    ...createPgCustomerPrivacyOperations(pool, orgId),
  });
}
