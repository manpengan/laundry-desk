import type { SqlClient } from "../db/types.js";
import { normalizeCustomerIdentifier } from "./normalization.js";
import type { CustomerRecord, CustomerSearchRow } from "./types.js";

type CustomerReadRow = Readonly<{
  id: string;
  phone: string;
  name: string | null;
  note: string | null;
  version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
  merged_into_id?: string | null;
}>;

function dateToEpoch(value: Date | string): number {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Math.floor(ms / 1000);
}

function mapRecord(row: CustomerReadRow): CustomerRecord {
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

function mapSearchRow(row: CustomerReadRow): CustomerSearchRow {
  return Object.freeze({
    customer_id: row.id,
    phone: row.phone,
    name: row.name,
    note: row.note,
    version: Number(row.version),
    updated_at: dateToEpoch(row.updated_at),
  });
}

export async function searchCustomerRows(
  client: SqlClient,
  orgId: string,
  query: string,
  limit: number,
): Promise<readonly CustomerSearchRow[]> {
  const capped = Math.max(0, Math.min(limit, 50));
  if (capped === 0) return Object.freeze([]);

  const q = query.trim();
  if (q.length === 0) {
    const result = await client.query<CustomerReadRow>(
      `SELECT id, phone, name, note, version, created_at, updated_at
       FROM customers
       WHERE org_id = $1::uuid AND merged_into_id IS NULL AND anonymized_at IS NULL
       ORDER BY updated_at DESC
       LIMIT $2`,
      [orgId, capped],
    );
    return Object.freeze(result.rows.map(mapSearchRow));
  }

  const contains = `%${q}%`;
  const normalizedIdentifier = normalizeCustomerIdentifier(q);
  const result = await client.query<CustomerReadRow>(
    `SELECT customer_row.id, customer_row.phone, customer_row.name, customer_row.note,
            customer_row.version, customer_row.created_at, customer_row.updated_at
     FROM customers customer_row
     WHERE customer_row.org_id = $1::uuid
       AND customer_row.merged_into_id IS NULL
       AND customer_row.anonymized_at IS NULL
       AND (
         customer_row.phone LIKE $2
         OR customer_row.phone ILIKE $3
         OR (customer_row.name IS NOT NULL AND customer_row.name ILIKE $3)
         OR customer_row.id IN (
           SELECT customer_canonical_root(identifier_row.customer_id)
             FROM customer_identifiers identifier_row
            WHERE identifier_row.org_id = $1::uuid
              AND identifier_row.retired_at IS NULL
              AND identifier_row.normalized_value = $4
         )
       )
     ORDER BY customer_row.updated_at DESC
     LIMIT $5`,
    [orgId, `${q}%`, contains, normalizedIdentifier, capped],
  );
  return Object.freeze(result.rows.map(mapSearchRow));
}

export async function getCustomerByPhoneRow(
  client: SqlClient,
  orgId: string,
  phone: string,
): Promise<CustomerRecord | null> {
  const result = await client.query<CustomerReadRow>(
    `SELECT root.id, root.phone, root.name, root.note, root.version,
            root.created_at, root.updated_at, root.merged_into_id
     FROM customers source
     JOIN customers root
       ON root.org_id = source.org_id
      AND root.id = customer_canonical_root(source.id)
     WHERE source.org_id = $1::uuid AND source.phone = $2
       AND source.anonymized_at IS NULL
       AND root.anonymized_at IS NULL
     LIMIT 1`,
    [orgId, phone],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapRecord(row);
}

export async function getCustomerByIdRow(
  client: SqlClient,
  orgId: string,
  customerId: string,
): Promise<CustomerRecord | null> {
  const result = await client.query<CustomerReadRow>(
    `SELECT root.id, root.phone, root.name, root.note, root.version,
            root.created_at, root.updated_at, root.merged_into_id
       FROM customers requested
       JOIN customers root
         ON root.org_id = requested.org_id
        AND root.id = customer_canonical_root(requested.id)
      WHERE requested.org_id = $1::uuid AND requested.id = $2::uuid
        AND root.merged_into_id IS NULL AND root.anonymized_at IS NULL
      LIMIT 1`,
    [orgId, customerId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapRecord(row);
}

export async function findCustomerDuplicateRows(
  client: SqlClient,
  orgId: string,
  customerId: string,
  limit: number,
): Promise<readonly CustomerSearchRow[]> {
  const result = await client.query<CustomerReadRow>(
    `SELECT candidate.id, candidate.phone, candidate.name, candidate.note, candidate.version,
            candidate.created_at, candidate.updated_at, candidate.merged_into_id
       FROM customers requested
       JOIN customers source
         ON source.org_id = requested.org_id
        AND source.id = customer_canonical_root(requested.id)
       JOIN customers candidate
         ON candidate.org_id = source.org_id
        AND candidate.id <> source.id
        AND candidate.merged_into_id IS NULL
        AND candidate.anonymized_at IS NULL
        AND source.name IS NOT NULL
        AND lower(btrim(candidate.name)) = lower(btrim(source.name))
      WHERE requested.org_id = $1::uuid AND requested.id = $2::uuid
        AND source.merged_into_id IS NULL
        AND source.anonymized_at IS NULL
      ORDER BY candidate.updated_at DESC
      LIMIT $3`,
    [orgId, customerId, Math.min(limit, 20)],
  );
  return Object.freeze(result.rows.map(mapSearchRow));
}
