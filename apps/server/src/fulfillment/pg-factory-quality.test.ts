import assert from "node:assert/strict";
import test from "node:test";

import type { QueryResult, SqlClient } from "../db/types.js";
import { recordPgFactoryQuality } from "./pg-factory-quality-write.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const STORE = "22222222-2222-4222-8222-222222222222";
const STAFF = "33333333-3333-4333-8333-333333333333";
const DEVICE = "44444444-4444-4444-8444-444444444444";
const ORDER = "55555555-5555-4555-8555-555555555555";
const GARMENT = "66666666-6666-4666-8666-666666666666";
const BATCH = "77777777-7777-4777-8777-777777777777";
const NOW = new Date("2026-08-12T00:00:00.000Z");

test("PostgreSQL QC permits another controlled rework inspection of a reworked garment", async () => {
  const sql: string[] = [];
  const client: SqlClient = Object.freeze({
    async query<TRow>(statement: string): Promise<QueryResult<TRow>> {
      sql.push(statement);
      let rows: readonly unknown[] = [];
      if (statement.includes("SELECT DISTINCT bg.order_id")) rows = [{ order_id: ORDER }];
      else if (statement.includes("SELECT o.id::text AS order_id")) {
        rows = [{ order_id: ORDER, status: "open", customer_pii_purged_at: null }];
      } else if (statement.includes("SELECT g.id::text AS garment_id")) {
        rows = [
          {
            garment_id: GARMENT,
            order_id: ORDER,
            ticket_no: "20260812-0001",
            barcode: "BC-001",
            status: "reworked",
            custody_state: "factory",
            active_production_batch_id: BATCH,
            garment_purged_at: null,
            order_status: "open",
            order_purged_at: null,
            member_state: "active",
            qc_status: "rework",
          },
        ];
      } else if (statement.includes("SELECT id::text AS batch_id")) {
        rows = [
          {
            batch_id: BATCH,
            factory_code: "FACTORY_A",
            status: "factory_received",
            version: 1,
            expected_garment_count: 1,
            exception_garment_count: 0,
          },
        ];
      } else if (statement.includes("statement_timestamp() AS now")) {
        rows = [{ now: NOW, epoch: Math.floor(NOW.getTime() / 1_000) }];
      } else if (statement.includes("MAX(inspection_no)")) rows = [{ inspection_no: 2 }];
      else if (statement.includes("UPDATE production_batches")) rows = [{ version: 2 }];
      return { rows: rows as readonly TRow[], rowCount: rows.length };
    },
  });
  const result = await recordPgFactoryQuality(
    client,
    {
      org_id: ORG,
      store_id: STORE,
      staff_id: STAFF,
      device_id: DEVICE,
      at: 0,
      batch_id: BATCH,
      expected_version: 1,
      garment_ids: Object.freeze([GARMENT]),
      checks: Object.freeze([
        Object.freeze({
          garment_id: GARMENT,
          outcome: "rework",
          reason_code: "finish_incomplete",
        }),
      ]),
    },
    () => "88888888-8888-4888-8888-888888888888",
  );
  assert.deepEqual(result && [result.version, result.pass_count, result.rework_count], [2, 0, 1]);
  assert.equal(
    sql.some((statement) => statement.includes("INSERT INTO garment_qc_log")),
    true,
  );
  assert.equal(
    sql.some((statement) => statement.includes("INSERT INTO garment_incidents")),
    true,
  );
});

test("PostgreSQL QC cannot change authority while factory dispatch has an unresolved discrepancy", async () => {
  const sql: string[] = [];
  const client: SqlClient = Object.freeze({
    async query<TRow>(statement: string): Promise<QueryResult<TRow>> {
      sql.push(statement);
      let rows: readonly unknown[] = [];
      if (statement.includes("SELECT DISTINCT bg.order_id")) rows = [{ order_id: ORDER }];
      else if (statement.includes("SELECT o.id::text AS order_id")) {
        rows = [{ order_id: ORDER, status: "open", customer_pii_purged_at: null }];
      } else if (statement.includes("SELECT g.id::text AS garment_id")) {
        rows = [
          {
            garment_id: GARMENT,
            order_id: ORDER,
            ticket_no: "20260812-0001",
            barcode: "BC-001",
            status: "ready",
            custody_state: "factory",
            active_production_batch_id: BATCH,
            garment_purged_at: null,
            order_status: "open",
            order_purged_at: null,
            member_state: "active",
            qc_status: "pass",
          },
        ];
      } else if (statement.includes("SELECT id::text AS batch_id")) {
        rows = [
          {
            batch_id: BATCH,
            factory_code: "FACTORY_A",
            status: "factory_received",
            version: 4,
            expected_garment_count: 1,
            exception_garment_count: 0,
          },
        ];
      } else if (statement.includes("SELECT EXISTS")) rows = [{ blocked: true }];
      return { rows: rows as readonly TRow[], rowCount: rows.length };
    },
  });

  const result = await recordPgFactoryQuality(
    client,
    {
      org_id: ORG,
      store_id: STORE,
      staff_id: STAFF,
      device_id: DEVICE,
      at: 0,
      batch_id: BATCH,
      expected_version: 4,
      garment_ids: Object.freeze([GARMENT]),
      checks: Object.freeze([
        Object.freeze({ garment_id: GARMENT, outcome: "pass", reason_code: null }),
      ]),
    },
    () => "88888888-8888-4888-8888-888888888888",
  );

  assert.equal(result, null);
  assert.equal(
    sql.some((statement) => statement.includes("INSERT INTO garment_qc_log")),
    false,
  );
  assert.equal(
    sql.some((statement) => statement.includes("UPDATE production_batches")),
    false,
  );
});
