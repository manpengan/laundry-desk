import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { QueryResult, SqlClient } from "../db/types.js";
import type { TenantContext } from "../db/types.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { transitionPgGarments } from "./pg-fulfillment-transition.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const STORE = "22222222-2222-4222-8222-222222222222";
const STAFF = "33333333-3333-4333-8333-333333333333";
const ORDER_A = "44444444-4444-4444-8444-444444444444";
const ORDER_B = "55555555-5555-4555-8555-555555555555";
const GARMENT_A = "66666666-6666-4666-8666-666666666666";
const GARMENT_B = "77777777-7777-4777-8777-777777777777";
const BATCH = "88888888-8888-4888-8888-888888888888";
const DEVICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const pgUrls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return Object.freeze({ promise, resolve });
}

async function waitForBackendLock(
  adminPool: ReturnType<typeof createPgPool>,
  backendPid: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const activity = await adminPool.query<Readonly<{ wait_event_type: string | null }>>(
      "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
      [backendPid],
    );
    if (activity.rows[0]?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("mark_lost did not wait on the first globally sorted order lock");
}

function prefixedUuid(prefix: string): string {
  return `${prefix}${randomUUID().slice(1)}`;
}

test("mark_lost locks every batch order and garment before its batch update", async () => {
  const sql: string[] = [];
  const calls: Readonly<{ statement: string; params: readonly unknown[] }>[] = [];
  let selectedIsException = true;
  const client: SqlClient = Object.freeze({
    async query<TRow>(
      statement: string,
      params: readonly unknown[] = [],
    ): Promise<QueryResult<TRow>> {
      sql.push(statement);
      calls.push(Object.freeze({ statement, params }));
      let rows: readonly unknown[] = [];
      if (
        statement.includes("SELECT g.order_id::text, g.id::text AS garment_id") &&
        !statement.includes("JOIN orders o")
      ) {
        rows = [
          {
            order_id: ORDER_B,
            garment_id: GARMENT_B,
            active_production_batch_id: BATCH,
          },
        ];
      } else if (
        statement.includes("SELECT g.id::text AS garment_id") &&
        statement.includes("JOIN orders o")
      ) {
        rows = [
          {
            garment_id: GARMENT_A,
            order_id: ORDER_A,
            status: "washing",
            order_status: "open",
            ticket_no: "20260812-0001",
            barcode: "BC-001",
            custody_state: "factory",
            active_production_batch_id: BATCH,
            member_state: "active",
            garment_purged_at: null,
            order_purged_at: null,
          },
          {
            garment_id: GARMENT_B,
            order_id: ORDER_B,
            status: "washing",
            order_status: "open",
            ticket_no: "20260812-0002",
            barcode: "BC-002",
            custody_state: selectedIsException ? "exception" : "factory",
            active_production_batch_id: BATCH,
            member_state: selectedIsException ? "exception" : "active",
            garment_purged_at: null,
            order_purged_at: null,
          },
        ];
      } else if (
        statement.includes("FROM batch_garments bg") &&
        statement.includes("bg.order_id::text")
      ) {
        rows = [
          { order_id: ORDER_A, garment_id: GARMENT_A },
          { order_id: ORDER_B, garment_id: GARMENT_B },
        ];
      } else if (statement.includes("SELECT o.id::text AS order_id")) {
        rows = [
          { order_id: ORDER_A, status: "open", customer_pii_purged_at: null },
          { order_id: ORDER_B, status: "open", customer_pii_purged_at: null },
        ];
      } else if (
        statement.includes("SELECT pb.id") &&
        statement.includes("FROM production_batches")
      ) {
        rows = [{ id: BATCH }];
      }
      return { rows: rows as readonly TRow[], rowCount: rows.length };
    },
  });
  const result = await transitionPgGarments(
    client,
    {
      org_id: ORG,
      store_id: STORE,
      garment_ids: Object.freeze([GARMENT_B]),
      target_status: "lost",
      staff_id: STAFF,
      device_id: DEVICE,
      at: 1_700_000_000,
      reason: "confirmed missing",
      confirmation_operation: "mark_lost",
      incident: Object.freeze({ kind: "lost", note: "confirmed missing", compensation_cents: 0 }),
    },
    () => "99999999-9999-4999-8999-999999999999",
  );
  assert.equal(result?.length, 1);
  const batchSubjectRead = sql.findIndex(
    (statement) =>
      statement.includes("FROM batch_garments bg") && statement.includes("bg.order_id::text"),
  );
  const fullOrderLock = sql.findIndex((statement) =>
    statement.includes("SELECT o.id::text AS order_id"),
  );
  const fullGarmentLock = sql.findIndex(
    (statement) => statement.includes("JOIN orders o") && statement.includes("FOR UPDATE OF g"),
  );
  const batchLock = sql.findIndex(
    (statement) => statement.includes("SELECT pb.id") && statement.includes("FOR UPDATE"),
  );
  const batchUpdate = sql.findIndex((statement) =>
    statement.includes("UPDATE production_batches pb"),
  );
  assert.ok(batchSubjectRead >= 0);
  assert.ok(batchSubjectRead < fullOrderLock);
  assert.ok(fullOrderLock < fullGarmentLock);
  assert.ok(fullGarmentLock < batchLock);
  assert.ok(batchLock < batchUpdate);
  const memberUpdate = calls.find((call) => call.statement.includes("UPDATE batch_garments"));
  const authorityUpdate = calls.find((call) =>
    call.statement.includes("UPDATE production_batches pb"),
  );
  assert.match(memberUpdate?.statement ?? "", /updated_at = statement_timestamp\(\)/u);
  assert.match(authorityUpdate?.statement ?? "", /updated_at = statement_timestamp\(\)/u);
  assert.equal(memberUpdate?.params[4], DEVICE);
  assert.equal(authorityUpdate?.params[4], DEVICE);

  selectedIsException = false;
  const activeMemberLoss = await transitionPgGarments(
    client,
    {
      org_id: ORG,
      store_id: STORE,
      garment_ids: Object.freeze([GARMENT_B]),
      target_status: "lost",
      staff_id: STAFF,
      device_id: DEVICE,
      at: 1_700_000_001,
      reason: "unresolved missing",
      confirmation_operation: "mark_lost",
    },
    () => "99999999-9999-4999-8999-999999999999",
  );
  assert.equal(activeMemberLoss, null);
});

test(
  "mark_lost targeting the later order cannot deadlock a concurrent full-batch factory lock",
  { skip: pgUrls === null },
  async () => {
    assert.ok(pgUrls);
    const adminPool = createPgPool({ connectionString: pgUrls.admin });
    const appPool = createPgPool({ connectionString: pgUrls.app, max: 2 });
    const factoryClient = await appPool.connect();
    const lossClient = await appPool.connect();
    const orderA = prefixedUuid("4");
    const orderB = prefixedUuid("5");
    const lineA = prefixedUuid("6");
    const lineB = prefixedUuid("7");
    const garmentA = prefixedUuid("6");
    const garmentB = prefixedUuid("7");
    const batchId = prefixedUuid("8");
    const attemptId = prefixedUuid("9");
    const tenant: TenantContext = Object.freeze({
      orgId: DEMO_ORG_ID,
      storeId: DEMO_STORE_ID,
      staffId: DEMO_STAFF_A_ID,
    });
    const factoryHasOrderA = deferred();
    const allowFactoryToContinue = deferred();
    let factoryWork: Promise<unknown> | null = null;
    let lossWork: Promise<unknown> | null = null;
    try {
      await seedPgTestIdentityFixture(adminPool);
      const now = new Date();
      const fixtureClient = await adminPool.connect();
      try {
        await fixtureClient.query("BEGIN");
        // Build an already reconciled exception graph without replaying the full R4 journey;
        // the tested app transactions below run with every production trigger enabled.
        await fixtureClient.query("SET LOCAL session_replication_role = 'replica'");
        await fixtureClient.query(
          `INSERT INTO orders (
           id, org_id, store_id, ticket_no, status, subtotal_cents, payable_cents,
           paid_cents, balance_cents, business_date, created_at, updated_at,
           created_by_staff_id
         ) VALUES
           ($1::uuid, $3::uuid, $4::uuid, $5, 'open', 0, 0, 0, 0, '2026-08-12', $7, $7, $8::uuid),
           ($2::uuid, $3::uuid, $4::uuid, $6, 'open', 0, 0, 0, 0, '2026-08-12', $7, $7, $8::uuid)`,
          [
            orderA,
            orderB,
            DEMO_ORG_ID,
            DEMO_STORE_ID,
            `LOCK-${orderA.slice(0, 8)}`,
            `LOCK-${orderB.slice(0, 8)}`,
            now,
            DEMO_STAFF_A_ID,
          ],
        );
        await fixtureClient.query(
          `INSERT INTO order_lines (
           id, org_id, store_id, order_id, line_index, service_code, category_code,
           unit_price_cents, qty, line_total_cents
         ) VALUES
           ($1::uuid, $5::uuid, $6::uuid, $3::uuid, 0, 'wash', 'shirt', 0, 1, 0),
           ($2::uuid, $5::uuid, $6::uuid, $4::uuid, 0, 'wash', 'shirt', 0, 1, 0)`,
          [lineA, lineB, orderA, orderB, DEMO_ORG_ID, DEMO_STORE_ID],
        );
        await fixtureClient.query(
          `INSERT INTO garments (
           id, org_id, store_id, order_id, order_line_id, seq, barcode,
           service_code, category_code, unit_price_cents, status
         ) VALUES
           ($1::uuid, $7::uuid, $8::uuid, $3::uuid, $5::uuid, 1, $9, 'wash', 'shirt', 0, 'washing'),
           ($2::uuid, $7::uuid, $8::uuid, $4::uuid, $6::uuid, 1, $10, 'wash', 'shirt', 0, 'washing')`,
          [
            garmentA,
            garmentB,
            orderA,
            orderB,
            lineA,
            lineB,
            DEMO_ORG_ID,
            DEMO_STORE_ID,
            `BC-${garmentA}`,
            `BC-${garmentB}`,
          ],
        );
        await fixtureClient.query(
          `INSERT INTO production_batches (
           id, org_id, store_id, factory_code, status, version,
           expected_garment_count, exception_garment_count,
           created_by_staff_id, created_by_device_id, created_at,
           updated_by_staff_id, updated_by_device_id, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, 'LOCK_TEST', 'factory_received', 1,
           2, 1, $4::uuid, $5::uuid, $6, $4::uuid, $5::uuid, $6
         )`,
          [batchId, DEMO_ORG_ID, DEMO_STORE_ID, DEMO_STAFF_A_ID, DEVICE, now],
        );
        await fixtureClient.query(
          `INSERT INTO batch_garments (
           org_id, store_id, batch_id, order_id, garment_id, state, qc_status,
           added_by_staff_id, added_by_device_id, added_at,
           updated_by_staff_id, updated_by_device_id, updated_at
         ) VALUES
           ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $6::uuid, 'active', 'pending',
            $8::uuid, $9::uuid, $10, $8::uuid, $9::uuid, $10),
           ($1::uuid, $2::uuid, $3::uuid, $5::uuid, $7::uuid, 'exception', 'pending',
            $8::uuid, $9::uuid, $10, $8::uuid, $9::uuid, $10)`,
          [
            DEMO_ORG_ID,
            DEMO_STORE_ID,
            batchId,
            orderA,
            orderB,
            garmentA,
            garmentB,
            DEMO_STAFF_A_ID,
            DEVICE,
            now,
          ],
        );
        await fixtureClient.query(
          `UPDATE garments
            SET custody_state = CASE WHEN id = $5::uuid THEN 'exception' ELSE 'factory' END,
                active_production_batch_id = $3::uuid
          WHERE org_id = $1::uuid AND store_id = $2::uuid
            AND id = ANY($4::uuid[])`,
          [DEMO_ORG_ID, DEMO_STORE_ID, batchId, [garmentA, garmentB], garmentB],
        );
        await fixtureClient.query(
          `INSERT INTO production_handoff_attempts (
             id, org_id, store_id, batch_id, batch_version, checkpoint, attempt_no,
             outcome, expected_count, scanned_count, matched_count, missing_count,
             unexpected_count, staff_id, device_id, recorded_at
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 'factory_receive', 1,
             'discrepancy', 2, 1, 1, 1, 0, $5::uuid, $6::uuid, $7
           )`,
          [attemptId, DEMO_ORG_ID, DEMO_STORE_ID, batchId, DEMO_STAFF_A_ID, DEVICE, now],
        );
        await fixtureClient.query(
          `INSERT INTO production_handoff_attempt_items (
             id, org_id, store_id, batch_id, attempt_id, checkpoint,
             garment_id, barcode, outcome, recorded_at
           ) VALUES
             ($1::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 'factory_receive',
              $7::uuid, $9, 'matched', $11),
             ($2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 'factory_receive',
              $8::uuid, $10, 'missing', $11)`,
          [
            randomUUID(),
            randomUUID(),
            DEMO_ORG_ID,
            DEMO_STORE_ID,
            batchId,
            attemptId,
            garmentA,
            garmentB,
            `BC-${garmentA}`,
            `BC-${garmentB}`,
            now,
          ],
        );
        await fixtureClient.query(
          `INSERT INTO production_handoff_discrepancy_resolutions (
             id, org_id, store_id, batch_id, checkpoint, attempt_id,
             resolution_code, staff_id, device_id, resolved_at
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'factory_receive', $5::uuid,
             'exception_accepted', $6::uuid, $7::uuid, $8
           )`,
          [
            randomUUID(),
            DEMO_ORG_ID,
            DEMO_STORE_ID,
            batchId,
            attemptId,
            DEMO_STAFF_A_ID,
            DEVICE,
            now,
          ],
        );
        await fixtureClient.query(
          `INSERT INTO production_handoff_checkpoints (
             id, org_id, store_id, batch_id, checkpoint, attempt_id, outcome,
             matched_count, missing_count, unexpected_count, staff_id, device_id, completed_at
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'factory_receive', $5::uuid, 'reconciled',
             1, 1, 0, $6::uuid, $7::uuid, $8
           )`,
          [
            randomUUID(),
            DEMO_ORG_ID,
            DEMO_STORE_ID,
            batchId,
            attemptId,
            DEMO_STAFF_A_ID,
            DEVICE,
            now,
          ],
        );
        await fixtureClient.query("COMMIT");
      } catch (error) {
        await fixtureClient.query("ROLLBACK");
        throw error;
      } finally {
        fixtureClient.release();
      }

      const factory = withTenantTransaction(
        factoryClient as unknown as SqlClient,
        tenant,
        async (client) => {
          await client.query("SET LOCAL statement_timeout = '5s'");
          await client.query(
            `SELECT id FROM orders
              WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
              FOR UPDATE`,
            [DEMO_ORG_ID, DEMO_STORE_ID, orderA],
          );
          factoryHasOrderA.resolve();
          await allowFactoryToContinue.promise;
          await client.query(
            `SELECT id FROM orders
              WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
              FOR UPDATE`,
            [DEMO_ORG_ID, DEMO_STORE_ID, orderB],
          );
          await client.query(
            `SELECT id FROM garments
              WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = ANY($3::uuid[])
              ORDER BY id FOR UPDATE`,
            [DEMO_ORG_ID, DEMO_STORE_ID, [garmentA, garmentB]],
          );
          await client.query(
            `SELECT id FROM production_batches
              WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
              FOR UPDATE`,
            [DEMO_ORG_ID, DEMO_STORE_ID, batchId],
          );
        },
      );
      factoryWork = factory;
      await factoryHasOrderA.promise;
      const lossPid = await lossClient.query<Readonly<{ pid: number }>>(
        "SELECT pg_backend_pid() AS pid",
      );
      const markingLost = withTenantTransaction(
        lossClient as unknown as SqlClient,
        tenant,
        async (client) => {
          await client.query("SET LOCAL statement_timeout = '5s'");
          return transitionPgGarments(
            client,
            {
              org_id: DEMO_ORG_ID,
              store_id: DEMO_STORE_ID,
              garment_ids: Object.freeze([garmentB]),
              target_status: "lost",
              staff_id: DEMO_STAFF_A_ID,
              device_id: DEVICE,
              at: Math.floor(Date.now() / 1000),
              reason: "confirmed missing",
              confirmation_operation: "mark_lost",
              incident: Object.freeze({
                kind: "lost",
                note: "confirmed missing",
                compensation_cents: 0,
              }),
            },
            randomUUID,
          );
        },
      );
      lossWork = markingLost;
      await waitForBackendLock(adminPool, lossPid.rows[0]!.pid);
      allowFactoryToContinue.resolve();
      const settled = await Promise.allSettled([factory, markingLost]);
      assert.equal(settled[0]?.status, "fulfilled");
      assert.equal(settled[1]?.status, "fulfilled");
      if (settled[1]?.status === "fulfilled") assert.equal(settled[1].value?.length, 1);
    } finally {
      allowFactoryToContinue.resolve();
      await Promise.allSettled(
        [factoryWork, lossWork].filter((work): work is Promise<unknown> => work !== null),
      );
      factoryClient.release();
      lossClient.release();
      const cleanupClient = await adminPool.connect();
      try {
        await cleanupClient.query("BEGIN");
        await cleanupClient.query("SET LOCAL session_replication_role = 'replica'");
        await cleanupClient.query(
          `UPDATE garments
            SET status = 'lost', custody_state = 'exception', active_production_batch_id = NULL
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = ANY($3::uuid[])`,
          [DEMO_ORG_ID, DEMO_STORE_ID, [garmentA, garmentB]],
        );
        await cleanupClient.query(
          `DELETE FROM garment_incidents
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND garment_id = ANY($3::uuid[])`,
          [DEMO_ORG_ID, DEMO_STORE_ID, [garmentA, garmentB]],
        );
        await cleanupClient.query(
          `DELETE FROM garment_status_log
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND garment_id = ANY($3::uuid[])`,
          [DEMO_ORG_ID, DEMO_STORE_ID, [garmentA, garmentB]],
        );
        await cleanupClient.query(
          `DELETE FROM production_handoff_checkpoints
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND batch_id = $3::uuid`,
          [DEMO_ORG_ID, DEMO_STORE_ID, batchId],
        );
        await cleanupClient.query(
          `DELETE FROM production_handoff_discrepancy_resolutions
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND batch_id = $3::uuid`,
          [DEMO_ORG_ID, DEMO_STORE_ID, batchId],
        );
        await cleanupClient.query(
          `DELETE FROM production_handoff_attempt_items
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND batch_id = $3::uuid`,
          [DEMO_ORG_ID, DEMO_STORE_ID, batchId],
        );
        await cleanupClient.query(
          `DELETE FROM production_handoff_attempts
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND batch_id = $3::uuid`,
          [DEMO_ORG_ID, DEMO_STORE_ID, batchId],
        );
        await cleanupClient.query(
          `DELETE FROM batch_garments
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND batch_id = $3::uuid`,
          [DEMO_ORG_ID, DEMO_STORE_ID, batchId],
        );
        await cleanupClient.query(
          `DELETE FROM production_batches
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
          [DEMO_ORG_ID, DEMO_STORE_ID, batchId],
        );
        await cleanupClient.query(
          `DELETE FROM garments
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = ANY($3::uuid[])`,
          [DEMO_ORG_ID, DEMO_STORE_ID, [garmentA, garmentB]],
        );
        await cleanupClient.query(
          `DELETE FROM order_lines
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = ANY($3::uuid[])`,
          [DEMO_ORG_ID, DEMO_STORE_ID, [lineA, lineB]],
        );
        await cleanupClient.query(
          `DELETE FROM orders
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = ANY($3::uuid[])`,
          [DEMO_ORG_ID, DEMO_STORE_ID, [orderA, orderB]],
        );
        await cleanupClient.query("COMMIT");
      } catch (error) {
        await cleanupClient.query("ROLLBACK");
        throw error;
      } finally {
        cleanupClient.release();
      }
      await Promise.all([appPool.end(), adminPool.end()]);
    }
  },
);
