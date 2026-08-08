/**
 * Unit tests for createPgShiftStore logic that does not need a database.
 *
 * What belongs here: argument validation that rejects before any query, the
 * defensive copy of the caller's options, row mapping, and the mapping of
 * PostgreSQL error codes onto domain errors. A mock pool is the right tool for
 * all four — they are decisions the store makes, not things PostgreSQL decides.
 *
 * What does NOT belong here: ordering, filtering, and persistence. Asserting a
 * regex over generated SQL only proves the string was assembled; it cannot show
 * what the database returns, which is how migration 0019 shipped a business_date
 * CHECK that rejected every date behind a green suite. Those live on a real
 * database in pg-shift-queries.test.ts (reads) and order/pg-workday.test.ts
 * (close, through the command bus).
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
  // The tenant scope reaches the driver. That the GUCs actually confine the read
  // is a database behaviour, proven in __tests__/rls-pg-integration.test.ts.
  assert.ok(queries.some((q) => q.params?.includes(DEMO_STORE_ID)));
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

test("getByBusinessDate rejects a scope different from the configured store", async () => {
  const { pool, queries } = createCapturingPool();
  const store = createPgShiftStore(pool, {
    orgId: DEMO_ORG_ID,
    storeId: DEMO_STORE_ID,
  });

  await assert.rejects(
    () =>
      store.getByBusinessDate("cccccccc-cccc-4ccc-8ccc-cccccccccccc", DEMO_STORE_ID, BUSINESS_DATE),
    /scope does not match configured org\/store/u,
  );
  assert.equal(queries.length, 0);
});

// The ordering and the strict earlier-than bound of getMostRecentBefore used to
// be asserted here as a regex over the generated SQL. That assertion could not
// fail if PostgreSQL sorted differently, so it moved to a real database in
// pg-shift-queries.test.ts. Only the scope forwarding stays mockable.
test("getMostRecentBefore scopes the query to the configured org and store", async () => {
  const { pool, queries } = createCapturingPool();
  const store = createPgShiftStore(pool, {
    orgId: DEMO_ORG_ID,
    storeId: DEMO_STORE_ID,
  });

  assert.equal(await store.getMostRecentBefore(DEMO_ORG_ID, DEMO_STORE_ID, BUSINESS_DATE), null);
  const select = queries.find((query) => query.params?.includes(BUSINESS_DATE));
  assert.ok(select, "the read must carry the requested business date");
  assert.deepEqual(select.params, [DEMO_ORG_ID, DEMO_STORE_ID, BUSINESS_DATE]);
});

test("configured scope is captured when the caller later mutates its options object", async () => {
  const { pool, queries } = createCapturingPool();
  const options = { orgId: DEMO_ORG_ID, storeId: DEMO_STORE_ID };
  const store = createPgShiftStore(pool, options);
  options.orgId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  const row = await store.getByBusinessDate(DEMO_ORG_ID, DEMO_STORE_ID, BUSINESS_DATE);

  assert.equal(row, null);
  // The store still uses the org it was built with, not the mutated one.
  assert.ok(queries.some((query) => query.params?.includes(DEMO_ORG_ID)));
  assert.equal(
    queries.some((query) => query.params?.includes("cccccccc-cccc-4ccc-8ccc-cccccccccccc")),
    false,
    "a later mutation of the options object must not reach the database",
  );
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

  // The write carries the caller's values through. Asserted by membership, not
  // by column position: a positional assertion (params[15]) breaks on every
  // added column while proving nothing about what was stored. That the row
  // actually lands in shift_closings is covered on a real database by
  // order/pg-workday.test.ts.
  const insert = queries.find((q) => q.sql.includes("INSERT INTO shift_closings"));
  assert.ok(insert);
  for (const expected of [SHIFT_ID, DEMO_ORG_ID, DEMO_STORE_ID, BUSINESS_DATE, "店员甲"]) {
    assert.ok(
      insert.params?.includes(expected),
      `close must send ${String(expected)} to the database`,
    );
  }
});

test("close business-date conflict maps to ShiftAlreadyClosedError", async () => {
  const { pool } = createCapturingPool((sql) => {
    if (isControlSql(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO shift_closings")) {
      const err = new Error("duplicate key value violates unique constraint") as Error & {
        code: string;
        constraint: string;
      };
      err.code = "23505";
      err.constraint = "shift_closings_store_date_uidx";
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

test("close preserves an unrelated unique violation", async () => {
  const primaryKeyError = Object.assign(new Error("duplicate shift id"), {
    code: "23505",
    constraint: "shift_closings_pkey",
  });
  const { pool } = createCapturingPool((sql) => {
    if (isControlSql(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO shift_closings")) throw primaryKeyError;
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
        signature_name: "店员丙",
        snapshot: Object.freeze({
          order_count: 0,
          payable_cents: 0,
          paid_cents: 0,
          payment_cents: 0,
        }),
        closed_at: CLOSED_EPOCH,
      }),
    (error: unknown) => error === primaryKeyError,
  );
});
