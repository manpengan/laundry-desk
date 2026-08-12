import assert from "node:assert/strict";
import test from "node:test";

import type { QueryResult, SqlClient } from "../db/types.js";
import { preparePgFactoryConfirmation } from "./pg-factory-confirmation.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const STORE = "22222222-2222-4222-8222-222222222222";
const STAFF = "33333333-3333-4333-8333-333333333333";
const DEVICE = "44444444-4444-4444-8444-444444444444";
const ORDER = "55555555-5555-4555-8555-555555555555";
const GARMENT = "66666666-6666-4666-8666-666666666666";
const BATCH = "77777777-7777-4777-8777-777777777777";

test("PostgreSQL confirmation refuses an exact rescan while a discrepancy is unresolved", async () => {
  const queries: string[] = [];
  const client: SqlClient = Object.freeze({
    async query<TRow>(sql: string): Promise<QueryResult<TRow>> {
      queries.push(sql);
      let rows: readonly unknown[] = [];
      if (sql.includes("SELECT DISTINCT bg.order_id")) rows = [{ order_id: ORDER }];
      else if (sql.includes("SELECT o.id::text AS order_id")) {
        rows = [{ order_id: ORDER, status: "open", customer_pii_purged_at: null }];
      } else if (sql.includes("SELECT g.id::text AS garment_id")) {
        rows = [
          {
            garment_id: GARMENT,
            order_id: ORDER,
            ticket_no: "20260812-0001",
            barcode: "BC-001",
            status: "received",
            custody_state: "store",
            active_production_batch_id: BATCH,
            garment_purged_at: null,
            order_status: "open",
            order_purged_at: null,
            member_state: "active",
            qc_status: "pending",
          },
        ];
      } else if (sql.includes("SELECT id::text AS batch_id")) {
        rows = [
          {
            batch_id: BATCH,
            factory_code: "FACTORY_A",
            status: "packing",
            version: 1,
            expected_garment_count: 1,
            exception_garment_count: 0,
          },
        ];
      } else if (sql.includes("SELECT EXISTS")) rows = [{ blocked: true }];
      return Object.freeze({ rows: rows as readonly TRow[], rowCount: rows.length });
    },
  });

  const summary = await preparePgFactoryConfirmation(client, {
    operation: "checkpoint_record",
    input: {
      org_id: ORG,
      store_id: STORE,
      staff_id: STAFF,
      device_id: DEVICE,
      at: 0,
      batch_id: BATCH,
      checkpoint: "store_dispatch",
      expected_version: 1,
      garment_ids: Object.freeze([GARMENT]),
      scanned_barcodes: Object.freeze(["BC-001"]),
    },
  });

  assert.equal(summary, null);
  assert.equal(
    queries.some((sql) => sql.includes("production_handoff_attempts attempt")),
    true,
  );
});
