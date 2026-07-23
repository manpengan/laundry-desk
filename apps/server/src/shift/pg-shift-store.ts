/**
 * Postgres ShiftStore: laundry_app + withStoreGuc (SET LOCAL tenant GUCs).
 * Table: shift_closings (0012). Append-only INSERT; one close per business_date.
 */

import { randomUUID } from "node:crypto";

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
import { withStoreGuc } from "../db/tenant-guc-client.js";
import { ShiftAlreadyClosedError } from "./memory-store.js";
import type { ShiftCloseInput, ShiftClosingRecord, ShiftStore } from "./types.js";

export type CreatePgShiftStoreOptions = Readonly<{
  orgId: string;
  storeId: string;
  /** Override UUID generation (tests). */
  newId?: () => string;
}>;

type ShiftClosingRow = Readonly<{
  id: string;
  org_id: string;
  store_id: string;
  business_date: string;
  closed_by_staff_id: string;
  note: string | null;
  order_count: number;
  payable_cents: number;
  paid_cents: number;
  payment_cents: number;
  signature_name: string;
  closed_at: Date | string;
}>;

function dateToEpoch(value: Date | string): number {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Math.floor(ms / 1000);
}

function epochToDate(epoch: number): Date {
  return new Date(epoch * 1000);
}

function mapRecord(row: ShiftClosingRow): ShiftClosingRecord {
  return Object.freeze({
    shift_id: row.id,
    org_id: row.org_id,
    store_id: row.store_id,
    business_date: row.business_date,
    closed_by_staff_id: row.closed_by_staff_id,
    note: row.note,
    order_count: row.order_count,
    payable_cents: row.payable_cents,
    paid_cents: row.paid_cents,
    payment_cents: row.payment_cents,
    signature_name: row.signature_name,
    closed_at: dateToEpoch(row.closed_at),
  });
}

/** Postgres unique_violation (23505). */
function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === "23505";
}

async function selectByBusinessDate(
  client: PgPoolClient,
  orgId: string,
  storeId: string,
  businessDate: string,
): Promise<ShiftClosingRecord | null> {
  const result = await client.query<ShiftClosingRow>(
    `SELECT id, org_id, store_id, business_date, closed_by_staff_id, note,
            order_count, payable_cents, paid_cents, payment_cents,
            signature_name, closed_at
     FROM shift_closings
     WHERE org_id = $1::uuid AND store_id = $2::uuid AND business_date = $3
     LIMIT 1`,
    [orgId, storeId, businessDate],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapRecord(row);
}

async function insertClose(
  client: PgPoolClient,
  input: ShiftCloseInput,
  newId: () => string,
): Promise<ShiftClosingRecord> {
  const shiftId = input.shift_id ?? newId();
  const closedAt = epochToDate(input.closed_at);
  const note = input.note ?? null;

  try {
    const result = await client.query<ShiftClosingRow>(
      `INSERT INTO shift_closings (
         id, org_id, store_id, business_date, closed_by_staff_id, note,
         order_count, payable_cents, paid_cents, payment_cents,
         signature_name, closed_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6,
         $7, $8, $9, $10,
         $11, $12
       )
       RETURNING id, org_id, store_id, business_date, closed_by_staff_id, note,
                 order_count, payable_cents, paid_cents, payment_cents,
                 signature_name, closed_at`,
      [
        shiftId,
        input.org_id,
        input.store_id,
        input.business_date,
        input.closed_by_staff_id,
        note,
        input.snapshot.order_count,
        input.snapshot.payable_cents,
        input.snapshot.paid_cents,
        input.snapshot.payment_cents,
        input.signature_name,
        closedAt,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("shift close insert returned no row");
    }
    return mapRecord(row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ShiftAlreadyClosedError(input.business_date);
    }
    throw error;
  }
}

/**
 * Create a ShiftStore backed by Postgres under laundry_app store RLS GUC.
 */
export function createPgShiftStore(pool: PgPool, options: CreatePgShiftStoreOptions): ShiftStore {
  const { orgId, storeId } = options;
  const newId = options.newId ?? randomUUID;

  return Object.freeze({
    getByBusinessDate: async (
      queryOrgId: string,
      queryStoreId: string,
      businessDate: string,
    ): Promise<ShiftClosingRecord | null> =>
      withStoreGuc(pool, { orgId, storeId }, async (client) =>
        selectByBusinessDate(client, queryOrgId, queryStoreId, businessDate),
      ),

    close: async (input: ShiftCloseInput): Promise<ShiftClosingRecord> =>
      withStoreGuc(pool, { orgId, storeId }, async (client) => insertClose(client, input, newId)),
  });
}
