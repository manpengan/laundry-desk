/**
 * Unit tests for createPgPrintJobStore with a capturing mock pool.
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
import { DEMO_ORG_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { createPgPrintJobStore } from "./pg-print-store.js";

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

const JOB_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const ORDER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function isControlSql(sql: string): boolean {
  return sql.includes("set_config") || sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK";
}

test("enqueue inserts queued print_jobs row under store GUC", async () => {
  const { pool, queries } = createCapturingPool((sql) => {
    if (isControlSql(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("INSERT INTO print_jobs")) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });

  const store = createPgPrintJobStore(pool, {
    orgId: DEMO_ORG_ID,
    storeId: DEMO_STORE_ID,
    newId: () => JOB_ID,
  });

  const job = await store.enqueue({
    order_id: ORDER_ID,
    ticket_no: "20260722-0001",
    kind: "xp58",
    job_id: JOB_ID,
    now: 1_700_000_000,
  });

  assert.equal(job.status, "queued");
  assert.equal(job.job_id, JOB_ID);
  assert.ok(queries.some((q) => q.sql.includes("set_config")));
  const insert = queries.find((q) => q.sql.includes("INSERT INTO print_jobs"));
  assert.ok(insert);
  assert.equal(insert?.params?.[0], JOB_ID);
  assert.equal(insert?.params?.[1], DEMO_ORG_ID);
  assert.equal(insert?.params?.[2], DEMO_STORE_ID);
  assert.equal(insert?.params?.[3], ORDER_ID);
  assert.equal(insert?.params?.[4], "20260722-0001");
  assert.equal(insert?.params?.[5], "xp58");
});

test("transition printing → done sets payload_bytes", async () => {
  const created = new Date("2024-01-01T00:00:00.000Z");
  const updated = new Date("2024-01-01T00:00:02.000Z");

  const { pool, queries } = createCapturingPool((sql, params) => {
    if (isControlSql(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT") && sql.includes("FROM print_jobs")) {
      return {
        rows: [
          {
            id: JOB_ID,
            kind: "xp58",
            status: "printing",
            order_id: ORDER_ID,
            ticket_no: "T1",
            created_at: created,
            updated_at: created,
            error: null,
            payload_bytes: null,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes("UPDATE print_jobs")) {
      return {
        rows: [
          {
            id: JOB_ID,
            kind: "xp58",
            status: params?.[3],
            order_id: ORDER_ID,
            ticket_no: "T1",
            created_at: created,
            updated_at: updated,
            error: params?.[4] ?? null,
            payload_bytes: params?.[5] ?? null,
          },
        ],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  });

  const store = createPgPrintJobStore(pool, {
    orgId: DEMO_ORG_ID,
    storeId: DEMO_STORE_ID,
  });

  const done = await store.transition(JOB_ID, "done", {
    now: 1_700_000_002,
    payload_bytes: 128,
  });
  assert.equal(done.status, "done");
  assert.equal(done.payload_bytes, 128);

  const update = queries.find((q) => q.sql.includes("UPDATE print_jobs"));
  assert.ok(update);
  assert.equal(update?.params?.[3], "done");
  assert.equal(update?.params?.[5], 128);
});

test("list returns newest-first mapped views", async () => {
  const t1 = new Date("2024-01-01T00:00:01.000Z");
  const t2 = new Date("2024-01-01T00:00:02.000Z");
  const { pool } = createCapturingPool((sql) => {
    if (isControlSql(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("ORDER BY created_at DESC")) {
      return {
        rows: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            kind: "xp58",
            status: "done",
            order_id: ORDER_ID,
            ticket_no: "new",
            created_at: t2,
            updated_at: t2,
            error: null,
            payload_bytes: 64,
          },
          {
            id: "11111111-1111-4111-8111-111111111111",
            kind: "dl206",
            status: "queued",
            order_id: ORDER_ID,
            ticket_no: "old",
            created_at: t1,
            updated_at: t1,
            error: null,
            payload_bytes: null,
          },
        ],
        rowCount: 2,
      };
    }
    return { rows: [], rowCount: 0 };
  });

  const store = createPgPrintJobStore(pool, {
    orgId: DEMO_ORG_ID,
    storeId: DEMO_STORE_ID,
  });
  const jobs = await store.list(10);
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0]?.ticket_no, "new");
  assert.equal(jobs[0]?.payload_bytes, 64);
  assert.equal(jobs[1]?.ticket_no, "old");
});
