/**
 * Postgres ShiftStore: laundry_app + withStoreGuc (SET LOCAL tenant GUCs).
 * Table: shift_closings (0012). Append-only INSERT; one close per business_date.
 */

import { randomUUID } from "node:crypto";

import type { PgPool } from "../db/pg-pool.js";
import { withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import type { SqlClient } from "../db/types.js";
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
  opening_float_cents: number;
  counted_cash_cents: number;
  retained_float_cents: number;
  expected_cash_cents: number;
  cash_difference_cents: number;
  signature_name: string;
  period_started_at: Date | string;
  period_ended_at: Date | string;
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
    opening_float_cents: row.opening_float_cents,
    counted_cash_cents: row.counted_cash_cents,
    retained_float_cents: row.retained_float_cents,
    expected_cash_cents: row.expected_cash_cents,
    cash_difference_cents: row.cash_difference_cents,
    signature_name: row.signature_name,
    period_started_at: dateToEpoch(row.period_started_at),
    period_ended_at: dateToEpoch(row.period_ended_at),
    closed_at: dateToEpoch(row.closed_at),
  });
}

/** Postgres unique_violation for one close per store/business date. */
function isBusinessDateConflict(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const pgError = error as { code?: unknown; constraint?: unknown };
  return pgError.code === "23505" && pgError.constraint === "shift_closings_store_date_uidx";
}

function assertConfiguredScope(
  orgId: string,
  storeId: string,
  configuredOrgId: string,
  configuredStoreId: string,
): void {
  if (orgId !== configuredOrgId || storeId !== configuredStoreId) {
    throw new Error("Shift store scope does not match configured org/store");
  }
}

async function selectByBusinessDate(
  client: SqlClient,
  orgId: string,
  storeId: string,
  businessDate: string,
): Promise<ShiftClosingRecord | null> {
  const result = await client.query<ShiftClosingRow>(
    `SELECT id, org_id, store_id, business_date, closed_by_staff_id, note,
            order_count, payable_cents, paid_cents, payment_cents,
            opening_float_cents, counted_cash_cents, retained_float_cents,
            expected_cash_cents, cash_difference_cents, signature_name,
            period_started_at, period_ended_at, closed_at
     FROM shift_closings
     WHERE org_id = $1::uuid AND store_id = $2::uuid AND business_date = $3
     LIMIT 1`,
    [orgId, storeId, businessDate],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapRecord(row);
}

async function selectMostRecent(
  client: SqlClient,
  orgId: string,
  storeId: string,
): Promise<ShiftClosingRecord | null> {
  const result = await client.query<ShiftClosingRow>(
    `SELECT id, org_id, store_id, business_date, closed_by_staff_id, note,
            order_count, payable_cents, paid_cents, payment_cents,
            opening_float_cents, counted_cash_cents, retained_float_cents,
            expected_cash_cents, cash_difference_cents, signature_name,
            period_started_at, period_ended_at, closed_at
     FROM shift_closings
     WHERE org_id = $1::uuid AND store_id = $2::uuid
     ORDER BY closed_at DESC, id DESC
     LIMIT 1`,
    [orgId, storeId],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapRecord(row);
}

async function insertClose(
  client: SqlClient,
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
         opening_float_cents, counted_cash_cents, retained_float_cents,
         expected_cash_cents, cash_difference_cents, signature_name,
         period_started_at, period_ended_at, closed_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6,
         $7, $8, $9, $10,
         $11, $12, $13, $14, $15, $16, $17, $18, $19
       )
       RETURNING id, org_id, store_id, business_date, closed_by_staff_id, note,
              order_count, payable_cents, paid_cents, payment_cents,
              opening_float_cents, counted_cash_cents, retained_float_cents,
              expected_cash_cents, cash_difference_cents, signature_name,
              period_started_at, period_ended_at, closed_at`,
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
        input.snapshot.opening_float_cents ?? 0,
        input.snapshot.counted_cash_cents ?? 0,
        input.snapshot.retained_float_cents ?? 0,
        input.snapshot.expected_cash_cents ?? 0,
        input.snapshot.cash_difference_cents ?? 0,
        input.signature_name,
        epochToDate(input.snapshot.period_started_at ?? input.closed_at),
        epochToDate(input.snapshot.period_ended_at ?? input.closed_at),
        closedAt,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("shift close insert returned no row");
    }
    return mapRecord(row);
  } catch (error) {
    if (isBusinessDateConflict(error)) {
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
    ): Promise<ShiftClosingRecord | null> => {
      assertConfiguredScope(queryOrgId, queryStoreId, orgId, storeId);
      return withStoreGucOrCurrent(pool, { orgId, storeId }, async (client) =>
        selectByBusinessDate(client, queryOrgId, queryStoreId, businessDate),
      );
    },

    close: async (input: ShiftCloseInput): Promise<ShiftClosingRecord> => {
      assertConfiguredScope(input.org_id, input.store_id, orgId, storeId);
      return withStoreGucOrCurrent(
        pool,
        { orgId, storeId, staffId: input.closed_by_staff_id },
        async (client) => insertClose(client, input, newId),
      );
    },

    getMostRecent: async (queryOrgId: string, queryStoreId: string) => {
      assertConfiguredScope(queryOrgId, queryStoreId, orgId, storeId);
      return withStoreGucOrCurrent(pool, { orgId, storeId }, async (client) =>
        selectMostRecent(client, orgId, storeId),
      );
    },
  });
}
