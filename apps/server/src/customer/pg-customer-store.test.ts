/**
 * Unit tests for createPgCustomerStore with a capturing mock pool.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
import { DEMO_ORG_ID } from "../local/demo-ids.js";
import { createPgCustomerStore } from "./pg-customer-store.js";

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

const FIXED_ID = "c3333333-3333-4333-8333-333333333333";
const AT = new Date("2024-01-15T12:00:00.000Z");

test("search empty query orders by updated_at desc and sets org GUC", async () => {
  const { pool, queries } = createCapturingPool((sql) => {
    if (sql.includes("set_config") || sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM customers") && sql.includes("ORDER BY updated_at DESC")) {
      return {
        rows: [
          {
            id: FIXED_ID,
            phone: "13800000222",
            name: "李四",
            note: null,
            created_at: AT,
            updated_at: AT,
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });

  const store = createPgCustomerStore(pool, { orgId: DEMO_ORG_ID });
  const rows = await store.search(undefined, 20);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.phone, "13800000222");
  assert.equal(rows[0]?.name, "李四");
  assert.equal(rows[0]?.updated_at, Math.floor(AT.getTime() / 1000));
  assert.ok(queries.some((q) => q.sql.includes("set_config")));
  assert.ok(queries.some((q) => q.sql.includes("app.org_id") || q.params?.includes(DEMO_ORG_ID)));
});

test("search with query uses ILIKE / prefix patterns", async () => {
  const { pool, queries } = createCapturingPool((sql) => {
    if (sql.includes("set_config") || sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("ILIKE")) {
      return {
        rows: [
          {
            id: FIXED_ID,
            phone: "13800000111",
            name: "张三",
            note: null,
            created_at: AT,
            updated_at: AT,
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });

  const store = createPgCustomerStore(pool, { orgId: DEMO_ORG_ID });
  const rows = await store.search("138000001", 10);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.phone, "13800000111");

  const searchQ = queries.find((q) => q.sql.includes("ILIKE"));
  assert.ok(searchQ);
  assert.deepEqual(searchQ?.params?.slice(1, 3), ["138000001%", "%138000001%"]);
});

test("getByPhone returns mapped record or null", async () => {
  let call = 0;
  const { pool } = createCapturingPool((sql) => {
    if (sql.includes("set_config") || sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("phone =")) {
      call += 1;
      if (call === 1) {
        return {
          rows: [
            {
              id: FIXED_ID,
              phone: "13800000111",
              name: "张三",
              note: "vip",
              created_at: AT,
              updated_at: AT,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  });

  const store = createPgCustomerStore(pool, { orgId: DEMO_ORG_ID });
  const found = await store.getByPhone("13800000111");
  assert.equal(found?.customer_id, FIXED_ID);
  assert.equal(found?.note, "vip");

  const missing = await store.getByPhone("13800000999");
  assert.equal(missing, null);
});

test("upsert insert path uses ON CONFLICT and reports created=true", async () => {
  const { pool, queries } = createCapturingPool((sql) => {
    if (sql.includes("set_config") || sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO customers")) {
      return {
        rows: [
          {
            id: FIXED_ID,
            phone: "13800000333",
            name: "王五",
            note: null,
            created_at: AT,
            updated_at: AT,
            was_inserted: true,
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });

  const store = createPgCustomerStore(pool, {
    orgId: DEMO_ORG_ID,
    newId: () => FIXED_ID,
  });
  const outcome = await store.upsert({
    phone: "13800000333",
    name: "王五",
    now: Math.floor(AT.getTime() / 1000),
  });

  assert.equal(outcome.created, true);
  assert.equal(outcome.customer.customer_id, FIXED_ID);
  assert.equal(outcome.customer.name, "王五");

  const insert = queries.find((q) => q.sql.includes("INSERT INTO customers"));
  assert.ok(insert);
  assert.ok(insert?.sql.includes("ON CONFLICT (org_id, phone)"));
  assert.equal(insert?.params?.[0], FIXED_ID);
  assert.equal(insert?.params?.[2], "13800000333");
  assert.equal(insert?.params?.[3], "王五");
  // updateName true, updateNote false
  assert.equal(insert?.params?.[6], true);
  assert.equal(insert?.params?.[7], false);
});

test("upsert conflict path reports created=false and preserves optional fields", async () => {
  const { pool, queries } = createCapturingPool((sql) => {
    if (sql.includes("set_config") || sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO customers")) {
      return {
        rows: [
          {
            id: FIXED_ID,
            phone: "13800000333",
            name: "王五改",
            note: "keep",
            created_at: AT,
            updated_at: new Date("2024-02-01T00:00:00.000Z"),
            was_inserted: false,
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });

  const store = createPgCustomerStore(pool, { orgId: DEMO_ORG_ID });
  const outcome = await store.upsert({
    phone: "13800000333",
    name: "王五改",
    now: 1_700_000_000,
  });

  assert.equal(outcome.created, false);
  assert.equal(outcome.customer.name, "王五改");
  assert.equal(outcome.customer.note, "keep");

  const insert = queries.find((q) => q.sql.includes("ON CONFLICT"));
  assert.ok(insert);
  assert.equal(insert?.params?.[6], true);
  assert.equal(insert?.params?.[7], false);
});
