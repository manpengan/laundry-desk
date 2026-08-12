import assert from "node:assert/strict";
import test from "node:test";

import type { QueryResult, SqlClient } from "../db/types.js";
import { recordPgFactoryCheckpoint } from "./pg-factory-checkpoint-write.js";
import { cancelPgFactoryBatch } from "./pg-factory-batch-write.js";
import { lockFactoryBatchGraph } from "./pg-factory-locks.js";
import { resolvePgFactoryDiscrepancy } from "./pg-factory-resolve-write.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const STORE = "22222222-2222-4222-8222-222222222222";
const STAFF = "33333333-3333-4333-8333-333333333333";
const DEVICE = "44444444-4444-4444-8444-444444444444";
const ORDER = "55555555-5555-4555-8555-555555555555";
const G1 = "66666666-6666-4666-8666-666666666666";
const G2 = "77777777-7777-4777-8777-777777777777";
const BATCH = "88888888-8888-4888-8888-888888888888";
const ATTEMPT = "99999999-9999-4999-8999-999999999999";
const NOW = new Date("2026-08-12T00:00:00.000Z");

const batch = Object.freeze({
  batch_id: BATCH,
  factory_code: "FACTORY_A",
  status: "packing",
  version: 1,
  expected_garment_count: 2,
  exception_garment_count: 0,
});

function garment(
  garmentId: string,
  barcode: string,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return Object.freeze({
    garment_id: garmentId,
    order_id: ORDER,
    ticket_no: "20260812-0001",
    barcode,
    status: "received",
    custody_state: "store",
    active_production_batch_id: BATCH,
    garment_purged_at: null,
    order_status: "open",
    order_purged_at: null,
    member_state: "active",
    qc_status: "pending",
    ...overrides,
  });
}

function scriptedGraphClient(
  rows: readonly unknown[],
  captured: string[],
  custom?: (sql: string) => readonly unknown[] | undefined,
): SqlClient {
  return Object.freeze({
    async query<TRow>(sql: string): Promise<QueryResult<TRow>> {
      captured.push(sql);
      const customResult = custom?.(sql);
      let result: readonly unknown[] = customResult ?? [];
      if (customResult !== undefined) {
        return { rows: result as readonly TRow[], rowCount: result.length };
      }
      if (sql.includes("SELECT DISTINCT bg.order_id")) result = [{ order_id: ORDER }];
      else if (sql.includes("SELECT o.id::text AS order_id")) {
        result = [{ order_id: ORDER, status: "open", customer_pii_purged_at: null }];
      } else if (sql.includes("SELECT g.id::text AS garment_id") && sql.includes("bg.state")) {
        result = rows;
      } else if (sql.includes("SELECT id::text AS batch_id")) result = [batch];
      else if (sql.includes("MAX(attempt_no)")) result = [{ attempt_no: 1 }];
      else if (sql.includes("statement_timestamp() AS now")) {
        result = [{ now: NOW, epoch: Math.floor(NOW.getTime() / 1_000) }];
      }
      return { rows: result as readonly TRow[], rowCount: result.length };
    },
  });
}

test("PostgreSQL discrepancy appends evidence without mutating the batch authority", async () => {
  const sql: string[] = [];
  const client = scriptedGraphClient([garment(G1, "BC-001"), garment(G2, "BC-002")], sql);
  let ids = 0;
  const result = await recordPgFactoryCheckpoint(
    client,
    {
      org_id: ORG,
      store_id: STORE,
      staff_id: STAFF,
      device_id: DEVICE,
      at: 0,
      batch_id: BATCH,
      checkpoint: "store_dispatch",
      expected_version: 1,
      garment_ids: Object.freeze([G1, G2]),
      scanned_barcodes: Object.freeze(["BC-001", "OUTSIDE"]),
    },
    () => (ids++ === 0 ? ATTEMPT : `aaaaaaaa-aaaa-4aaa-8aaa-${String(ids).padStart(12, "0")}`),
  );
  assert.deepEqual(
    result && {
      status: result.status,
      version: result.version,
      outcome: result.outcome,
      missing: result.missing_count,
      unexpected: result.unexpected_count,
    },
    { status: "packing", version: 1, outcome: "discrepancy", missing: 1, unexpected: 1 },
  );
  assert.equal(
    sql.some((statement) => statement.includes("INSERT INTO production_handoff_attempts")),
    true,
  );
  assert.equal(
    sql.some(
      (statement) =>
        statement.includes("INSERT INTO production_handoff_attempts") &&
        statement.includes("batch_version"),
    ),
    true,
  );
  assert.equal(
    sql.some((statement) => statement.includes("UPDATE production_batches")),
    false,
  );
  assert.equal(
    sql.some((statement) => statement.includes("UPDATE garments")),
    false,
  );
});

test("PostgreSQL exact rescan cannot bypass an unresolved discrepancy", async () => {
  const sql: string[] = [];
  const client = scriptedGraphClient(
    [garment(G1, "BC-001"), garment(G2, "BC-002")],
    sql,
    (statement) =>
      statement.includes("AS blocked") &&
      statement.includes("production_handoff_discrepancy_resolutions")
        ? [{ blocked: true }]
        : undefined,
  );
  const result = await recordPgFactoryCheckpoint(
    client,
    {
      org_id: ORG,
      store_id: STORE,
      staff_id: STAFF,
      device_id: DEVICE,
      at: 0,
      batch_id: BATCH,
      checkpoint: "store_dispatch",
      expected_version: 1,
      garment_ids: Object.freeze([G1, G2]),
      scanned_barcodes: Object.freeze(["BC-001", "BC-002"]),
    },
    () => ATTEMPT,
  );
  assert.equal(result, null);
  assert.equal(
    sql.some((statement) => /^\s*(?:INSERT|UPDATE)\b/u.test(statement)),
    false,
  );
});

test("batch graph accepts a lost historical exception while retaining active anchors", async () => {
  const sql: string[] = [];
  const client = scriptedGraphClient(
    [
      garment(G1, "BC-001", {
        status: "lost",
        order_status: "closed",
        custody_state: "exception",
        active_production_batch_id: null,
        member_state: "exception",
      }),
      garment(G2, "BC-002"),
    ],
    sql,
  );
  const graph = await lockFactoryBatchGraph(client, { org_id: ORG, store_id: STORE }, BATCH);
  assert.equal(graph?.garments.length, 2);
});

test("PostgreSQL cancellation persists its controlled reason with the terminal update", async () => {
  const calls: Readonly<{ sql: string; params: readonly unknown[] }>[] = [];
  const base = scriptedGraphClient(
    [garment(G1, "BC-001"), garment(G2, "BC-002")],
    [],
    (statement) => (statement.includes("UPDATE production_batches") ? [{ version: 2 }] : undefined),
  );
  const client: SqlClient = Object.freeze({
    query: async <TRow>(sql: string, params: readonly unknown[] = []) => {
      calls.push(Object.freeze({ sql, params }));
      return base.query<TRow>(sql, params);
    },
  });
  const result = await cancelPgFactoryBatch(client, {
    org_id: ORG,
    store_id: STORE,
    staff_id: STAFF,
    device_id: DEVICE,
    at: 0,
    batch_id: BATCH,
    expected_version: 1,
    reason_code: "operational_error",
  });
  assert.equal(result?.status, "cancelled");
  const update = calls.find((call) => call.sql.includes("UPDATE production_batches"));
  assert.match(update?.sql ?? "", /cancel_reason_code = \$8/u);
  assert.match(update?.sql ?? "", /completed_at = \$6/u);
  assert.equal(update?.params[7], "operational_error");
});

test("PostgreSQL reconciliation refuses an all-active-missing dead batch before writes", async () => {
  const sql: string[] = [];
  const client = scriptedGraphClient(
    [garment(G1, "BC-001"), garment(G2, "BC-002")],
    sql,
    (statement) => {
      if (
        statement.includes("FROM production_handoff_attempts") &&
        statement.includes("id::text AS attempt_id")
      ) {
        return [
          {
            attempt_id: ATTEMPT,
            batch_version: 1,
            checkpoint: "store_dispatch",
            outcome: "discrepancy",
            matched_count: 0,
            missing_count: 2,
            unexpected_count: 1,
          },
        ];
      }
      if (statement.includes("FROM production_handoff_discrepancy_resolutions")) return [];
      if (statement.includes("FROM production_handoff_attempt_items")) {
        return [
          { garment_id: G1, barcode: "BC-001", outcome: "missing" },
          { garment_id: G2, barcode: "BC-002", outcome: "missing" },
          { garment_id: null, barcode: "OUTSIDE", outcome: "unexpected" },
        ];
      }
      return undefined;
    },
  );
  const result = await resolvePgFactoryDiscrepancy(
    client,
    {
      org_id: ORG,
      store_id: STORE,
      staff_id: STAFF,
      device_id: DEVICE,
      at: 0,
      batch_id: BATCH,
      attempt_id: ATTEMPT,
      expected_version: 1,
      garment_ids: Object.freeze([G1, G2]),
      reason_code: "exception_accepted",
    },
    () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  );
  assert.equal(result, null);
  assert.equal(
    sql.some((statement) => /^\s*(?:INSERT|UPDATE)\b/u.test(statement)),
    false,
  );
});

test("PostgreSQL reconciliation rejects a stale latest attempt after the batch version changes", async () => {
  const sql: string[] = [];
  const client = scriptedGraphClient(
    [garment(G1, "BC-001"), garment(G2, "BC-002")],
    sql,
    (statement) => {
      if (statement.includes("SELECT id::text AS batch_id")) {
        return [{ ...batch, version: 2 }];
      }
      if (
        statement.includes("FROM production_handoff_attempts") &&
        statement.includes("id::text AS attempt_id")
      ) {
        return [
          {
            attempt_id: ATTEMPT,
            batch_version: 1,
            checkpoint: "store_dispatch",
            outcome: "discrepancy",
            matched_count: 1,
            missing_count: 1,
            unexpected_count: 0,
          },
        ];
      }
      if (statement.includes("FROM production_handoff_discrepancy_resolutions")) return [];
      if (statement.includes("FROM production_handoff_attempt_items")) {
        return [
          { garment_id: G1, barcode: "BC-001", outcome: "matched" },
          { garment_id: G2, barcode: "BC-002", outcome: "missing" },
        ];
      }
      return undefined;
    },
  );
  const result = await resolvePgFactoryDiscrepancy(
    client,
    {
      org_id: ORG,
      store_id: STORE,
      staff_id: STAFF,
      device_id: DEVICE,
      at: 0,
      batch_id: BATCH,
      attempt_id: ATTEMPT,
      expected_version: 2,
      garment_ids: Object.freeze([G2]),
      reason_code: "exception_accepted",
    },
    () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  );
  assert.equal(result, null);
  assert.equal(
    sql.some((statement) => /^\s*(?:INSERT|UPDATE)\b/u.test(statement)),
    false,
  );
});

test("PostgreSQL reconciliation selects authority by current version, checkpoint, and attempt number", async () => {
  const calls: Readonly<{ sql: string; params: readonly unknown[] }>[] = [];
  const base = scriptedGraphClient(
    [garment(G1, "BC-001"), garment(G2, "BC-002")],
    [],
    (statement) => {
      if (
        statement.includes("FROM production_handoff_attempts") &&
        statement.includes("id::text AS attempt_id")
      ) {
        return [
          {
            attempt_id: ATTEMPT,
            batch_version: 1,
            checkpoint: "store_dispatch",
            outcome: "discrepancy",
            matched_count: 1,
            missing_count: 1,
            unexpected_count: 0,
          },
        ];
      }
      if (statement.includes("FROM production_handoff_discrepancy_resolutions")) return [];
      if (statement.includes("FROM production_handoff_attempt_items")) {
        return [
          { garment_id: G1, barcode: "BC-001", outcome: "matched" },
          { garment_id: G2, barcode: "BC-002", outcome: "missing" },
        ];
      }
      return undefined;
    },
  );
  const client: SqlClient = Object.freeze({
    query: async <TRow>(sql: string, params: readonly unknown[] = []) => {
      calls.push(Object.freeze({ sql, params }));
      return base.query<TRow>(sql, params);
    },
  });
  await resolvePgFactoryDiscrepancy(
    client,
    {
      org_id: ORG,
      store_id: STORE,
      staff_id: STAFF,
      device_id: DEVICE,
      at: 0,
      batch_id: BATCH,
      attempt_id: ATTEMPT,
      expected_version: 1,
      garment_ids: Object.freeze([G2]),
      reason_code: "exception_accepted",
    },
    () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  );
  const authority = calls.find(
    (call) =>
      call.sql.includes("FROM production_handoff_attempts") &&
      call.sql.includes("id::text AS attempt_id"),
  );
  assert.match(authority?.sql ?? "", /batch_version = \$4 AND checkpoint = \$5/u);
  assert.match(authority?.sql ?? "", /ORDER BY attempt_no DESC/u);
  assert.doesNotMatch(authority?.sql ?? "", /FOR UPDATE/u);
  assert.equal(authority?.params[3], 1);
  assert.equal(authority?.params[4], "store_dispatch");
});
