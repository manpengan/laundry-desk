/**
 * Unit tests for createPgShiftStore with a capturing mock pool.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { ShiftAlreadyClosedError } from "./memory-store.js";
import { createPgShiftStore } from "./pg-shift-store.js";

type RecordedQuery = Readonly<{
  sql: string;
  params: readonly unknown[] | undefined;
}>;

type MockQueryHandler = (
  sql: string,
  params: readonly unknown[] | undefined,
) => { rows: readonly unknown[]; rowCount: number };

function createCapturingPool(handler?: MockQueryHandler): {
  pool: PgPool;
  queries: RecordedQuery[];
} {
  const queries: RecordedQuery[] = [];
  const queryImpl = async (
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: readonly unknown[]; rowCount: number }> => {
    queries.push(Object.freeze({ sql, params }));
    if (handler !== undefined) {
      return handler(sql, params);
    }
    return { rows: [], rowCount: 0 };
  };

  const client = {
    query: queryImpl,
    release() {
      // mock
    },
  } as unknown as PgPoolClient;

  const pool = {
    connect: async () => client,
    query: queryImpl,
  } as unknown as PgPool;

  return { pool, queries };
}

function isControlSql(sql: string): boolean {
  return sql.includes("set_config") || sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK";
}

const SHIFT_ID = "s1111111-1111-4111-8111-111111111111";
const BUSINESS_DATE = "2024-07-22";
const CLOSED_AT = new Date("2024-07-22T00:00:00.000Z");
const CLOSED_EPOCH = Math.floor(CLOSED_AT.getTime() / 1000);

test("getByBusinessDate returns mapped row under store GUC", async () => {
  const { pool, queries } = createCapturingPool((sql) => {
    if (isControlSql(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM shift_closings") && sql.includes("business_date")) {
      return {
        rows: [
          {
            id: SHIFT_ID,
            org_id: DEMO_ORG_ID,
            store_id: DEMO_STORE_ID,
            business_date: BUSINESS_DATE,
            closed_by_staff_id: DEMO_STAFF_A_ID,
            note: "晚班",
            order_count: 3,
            payable_cents: 12000,
            paid_cents: 4000,
            payment_cents: 2000,
            signature_name: "店员甲",
            closed_at: CLOSED_AT,
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });

  const store = createPgShiftStore(pool, {
    orgId: DEMO_ORG_ID,
    storeId: DEMO_STORE_ID,
  });
  const row = await store.getByBusinessDate(DEMO_ORG_ID, DEMO_STORE_ID, BUSINESS_DATE);

  assert.ok(row);
  assert.equal(row.shift_id, SHIFT_ID);
  assert.equal(row.business_date, BUSINESS_DATE);
  assert.equal(row.order_count, 3);
  assert.equal(row.payable_cents, 12000);
  assert.equal(row.signature_name, "店员甲");
  assert.equal(row.closed_at, CLOSED_EPOCH);
  assert.equal(row.note, "晚班");
  assert.ok(queries.some((q) => q.sql.includes("set_config")));
  assert.ok(
    queries.some((q) => q.sql.includes("app.store_id") || q.params?.includes(DEMO_STORE_ID)),
  );
});

test("getByBusinessDate returns null when missing", async () => {
  const { pool } = createCapturingPool((sql) => {
    if (isControlSql(sql)) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  });

  const store = createPgShiftStore(pool, {
    orgId: DEMO_ORG_ID,
    storeId: DEMO_STORE_ID,
  });
  const row = await store.getByBusinessDate(DEMO_ORG_ID, DEMO_STORE_ID, BUSINESS_DATE);
  assert.equal(row, null);
});

test("close inserts shift_closings row and maps RETURNING", async () => {
  const { pool, queries } = createCapturingPool((sql) => {
    if (isControlSql(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO shift_closings")) {
      return {
        rows: [
          {
            id: SHIFT_ID,
            org_id: DEMO_ORG_ID,
            store_id: DEMO_STORE_ID,
            business_date: BUSINESS_DATE,
            closed_by_staff_id: DEMO_STAFF_A_ID,
            note: null,
            order_count: 1,
            payable_cents: 3000,
            paid_cents: 500,
            payment_cents: 0,
            signature_name: "店员甲",
            closed_at: CLOSED_AT,
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });

  const store = createPgShiftStore(pool, {
    orgId: DEMO_ORG_ID,
    storeId: DEMO_STORE_ID,
    newId: () => SHIFT_ID,
  });

  const record = await store.close({
    org_id: DEMO_ORG_ID,
    store_id: DEMO_STORE_ID,
    business_date: BUSINESS_DATE,
    closed_by_staff_id: DEMO_STAFF_A_ID,
    signature_name: "店员甲",
    snapshot: Object.freeze({
      order_count: 1,
      payable_cents: 3000,
      paid_cents: 500,
      payment_cents: 0,
    }),
    closed_at: CLOSED_EPOCH,
  });

  assert.equal(record.shift_id, SHIFT_ID);
  assert.equal(record.order_count, 1);
  assert.equal(record.payable_cents, 3000);
  assert.equal(record.signature_name, "店员甲");

  const insert = queries.find((q) => q.sql.includes("INSERT INTO shift_closings"));
  assert.ok(insert);
  assert.equal(insert?.params?.[0], SHIFT_ID);
  assert.equal(insert?.params?.[1], DEMO_ORG_ID);
  assert.equal(insert?.params?.[2], DEMO_STORE_ID);
  assert.equal(insert?.params?.[3], BUSINESS_DATE);
  assert.equal(insert?.params?.[4], DEMO_STAFF_A_ID);
  assert.equal(insert?.params?.[6], 1);
  assert.equal(insert?.params?.[7], 3000);
  assert.equal(insert?.params?.[10], "店员甲");
});

test("close unique violation maps to ShiftAlreadyClosedError", async () => {
  const { pool } = createCapturingPool((sql) => {
    if (isControlSql(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO shift_closings")) {
      const err = new Error("duplicate key value violates unique constraint") as Error & {
        code: string;
      };
      err.code = "23505";
      throw err;
    }
    return { rows: [], rowCount: 0 };
  });

  const store = createPgShiftStore(pool, {
    orgId: DEMO_ORG_ID,
    storeId: DEMO_STORE_ID,
  });

  await assert.rejects(
    () =>
      store.close({
        org_id: DEMO_ORG_ID,
        store_id: DEMO_STORE_ID,
        business_date: BUSINESS_DATE,
        closed_by_staff_id: DEMO_STAFF_A_ID,
        signature_name: "店员乙",
        snapshot: Object.freeze({
          order_count: 0,
          payable_cents: 0,
          paid_cents: 0,
          payment_cents: 0,
        }),
        closed_at: CLOSED_EPOCH,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ShiftAlreadyClosedError);
      assert.equal(error.businessDate, BUSINESS_DATE);
      return true;
    },
  );
});
