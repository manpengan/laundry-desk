import assert from "node:assert/strict";
import test from "node:test";

import type { QueryResult, SqlClient } from "../db/types.js";
import { getPgFactoryBatch } from "./pg-factory-read.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const STORE = "22222222-2222-4222-8222-222222222222";
const BATCH = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-08-12T00:00:00.000Z");

test("batch detail relies on the query snapshot and scopes latest attempt authority", async () => {
  const calls: Readonly<{ sql: string; params: readonly unknown[] }>[] = [];
  const client: SqlClient = Object.freeze({
    async query<TRow>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<TRow>> {
      calls.push(Object.freeze({ sql, params }));
      let rows: readonly unknown[] = [];
      if (sql.includes("FROM production_batches pb")) {
        rows = [
          {
            batch_id: BATCH,
            factory_code: "FACTORY_A",
            status: "factory_received",
            version: 7,
            manifest_count: 1,
            exception_count: 0,
            updated_at: NOW,
          },
        ];
      }
      return { rows: rows as readonly TRow[], rowCount: rows.length };
    },
  });
  const detail = await getPgFactoryBatch(client, ORG, STORE, BATCH);
  assert.equal(detail?.batch.version, 7);
  const batchRead = calls.find((call) => call.sql.includes("FROM production_batches pb"));
  assert.doesNotMatch(batchRead?.sql ?? "", /FOR (?:UPDATE|SHARE)/u);
  const attemptRead = calls.find((call) => call.sql.includes("FROM production_handoff_attempts"));
  assert.match(attemptRead?.sql ?? "", /batch_version = \$4 AND checkpoint = \$5/u);
  assert.match(attemptRead?.sql ?? "", /ORDER BY attempt_no DESC/u);
  assert.equal(attemptRead?.params[3], 7);
  assert.equal(attemptRead?.params[4], "factory_dispatch");
});
