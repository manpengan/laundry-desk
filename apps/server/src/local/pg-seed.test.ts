import assert from "node:assert/strict";
import test from "node:test";

import type { PgPool, PgPoolClient } from "../db/pg-pool.js";
import { LOCAL_PROFILE } from "./profile.js";
import { seedDemoIdentity } from "./pg-seed.js";

type RecordedQuery = Readonly<{
  sql: string;
  params: readonly unknown[] | undefined;
}>;

function createCapturingPool(): Readonly<{
  pool: PgPool;
  queries: RecordedQuery[];
}> {
  const queries: RecordedQuery[] = [];
  const query = async (
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: readonly unknown[]; rowCount: number }> => {
    queries.push(Object.freeze({ sql, params }));
    return { rows: [], rowCount: 0 };
  };
  const client = {
    query,
    release(): void {
      // Capturing test double.
    },
  } as unknown as PgPoolClient;

  return Object.freeze({
    pool: { connect: async () => client } as unknown as PgPool,
    queries,
  });
}

test("rerun store upsert refreshes timezone from LOCAL_PROFILE", async () => {
  const { pool, queries } = createCapturingPool();

  await seedDemoIdentity(pool);
  await seedDemoIdentity(pool);

  const storeUpserts = queries.filter((query) => query.sql.includes("INSERT INTO stores"));
  assert.equal(storeUpserts.length, 2);
  for (const upsert of storeUpserts) {
    assert.match(
      upsert.sql,
      /ON CONFLICT \(id\) DO UPDATE SET[\s\S]*timezone = EXCLUDED\.timezone/u,
    );
    assert.equal(upsert.params?.[4], LOCAL_PROFILE.timezone);
  }
});
