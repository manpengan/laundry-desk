import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { FactoryHandoffConfirmationSummarySchema } from "@laundry/contracts";

import { createPgPool, resolvePgUrls, type PgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { createPgPendingActionStore } from "../pending-actions/pg-store.js";
import { preparePgFactoryConfirmation } from "./pg-factory-confirmation.js";
import { recordPgFactoryCheckpoint } from "./pg-factory-checkpoint-write.js";
import { getPgFactoryBatch } from "./pg-factory-read.js";
import { recordPgFactoryQuality } from "./pg-factory-quality-write.js";

const DEVICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const pgUrls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;

type Fixture = Readonly<{
  batchId: string;
  orderIds: readonly string[];
  lineIds: readonly string[];
  garmentIds: readonly string[];
  barcodes: readonly string[];
}>;

const tenant: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_STAFF_A_ID,
});

const withAppTransaction = <T>(
  pool: PgPool,
  operation: (client: SqlClient) => Promise<T>,
): Promise<T> => withPoolClient(pool, (client) => withTenantTransaction(client, tenant, operation));

function fixture(count: number): Fixture {
  return Object.freeze({
    batchId: randomUUID(),
    orderIds: Object.freeze(Array.from({ length: count }, () => randomUUID())),
    lineIds: Object.freeze(Array.from({ length: count }, () => randomUUID())),
    garmentIds: Object.freeze(Array.from({ length: count }, () => randomUUID())),
    barcodes: Object.freeze(
      Array.from({ length: count }, (_, index) => `FACTORY-${index + 1}-${randomUUID()}`),
    ),
  });
}

async function seedBaseRows(
  adminPool: PgPool,
  rows: Fixture,
  options: Readonly<{
    batchStatus: "packing" | "factory_received";
    garmentStatus: "received" | "reworked";
    custodyState: "store" | "factory";
    qcStatus: "pending" | "rework";
  }>,
): Promise<void> {
  const client = await adminPool.connect();
  const now = new Date(Date.now() - 60_000);
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = 'replica'");
    for (const [index, orderId] of rows.orderIds.entries()) {
      await client.query(
        `INSERT INTO orders (
           id, org_id, store_id, ticket_no, status, subtotal_cents, payable_cents,
           paid_cents, balance_cents, business_date, created_at, updated_at,
           created_by_staff_id
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, 'open', 0, 0, 0, 0,
           '2026-08-12', $5, $5, $6::uuid
         )`,
        [
          orderId,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          `FACTORY-${orderId.slice(0, 8)}`,
          now,
          DEMO_STAFF_A_ID,
        ],
      );
      await client.query(
        `INSERT INTO order_lines (
           id, org_id, store_id, order_id, line_index, service_code, category_code,
           unit_price_cents, qty, line_total_cents
         ) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 0, 'wash', 'shirt', 0, 1, 0)`,
        [rows.lineIds[index], DEMO_ORG_ID, DEMO_STORE_ID, orderId],
      );
      await client.query(
        `INSERT INTO garments (
           id, org_id, store_id, order_id, order_line_id, seq, barcode,
           service_code, category_code, unit_price_cents, status,
           custody_state, active_production_batch_id
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 1, $6,
           'wash', 'shirt', 0, $7, $8, $9::uuid
         )`,
        [
          rows.garmentIds[index],
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          orderId,
          rows.lineIds[index],
          rows.barcodes[index],
          options.garmentStatus,
          options.custodyState,
          rows.batchId,
        ],
      );
    }
    await client.query(
      `INSERT INTO production_batches (
         id, org_id, store_id, factory_code, status, version,
         expected_garment_count, exception_garment_count,
         created_by_staff_id, created_by_device_id, created_at,
         updated_by_staff_id, updated_by_device_id, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'FACTORY_TEST', $4, 1,
         $5, 0, $6::uuid, $7::uuid, $8, $6::uuid, $7::uuid, $8
       )`,
      [
        rows.batchId,
        DEMO_ORG_ID,
        DEMO_STORE_ID,
        options.batchStatus,
        rows.garmentIds.length,
        DEMO_STAFF_A_ID,
        DEVICE,
        now,
      ],
    );
    for (const [index, garmentId] of rows.garmentIds.entries()) {
      await client.query(
        `INSERT INTO batch_garments (
           org_id, store_id, batch_id, order_id, garment_id, state, qc_status,
           added_by_staff_id, added_by_device_id, added_at,
           updated_by_staff_id, updated_by_device_id, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'active', $6,
           $7::uuid, $8::uuid, $9, $7::uuid, $8::uuid, $9
         )`,
        [
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          rows.batchId,
          rows.orderIds[index],
          garmentId,
          options.qcStatus,
          DEMO_STAFF_A_ID,
          DEVICE,
          now,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function cleanupFixture(adminPool: PgPool, rows: Fixture): Promise<void> {
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(
      `DELETE FROM ai_pending_actions
        WHERE org_id = $1::uuid AND store_id = $2::uuid
          AND args_json ->> 'batch_id' = $3`,
      [DEMO_ORG_ID, DEMO_STORE_ID, rows.batchId],
    );
    for (const table of [
      "garment_qc_log",
      "production_handoff_checkpoints",
      "production_handoff_discrepancy_resolutions",
      "production_handoff_attempt_items",
      "production_handoff_attempts",
      "batch_garments",
    ]) {
      await client.query(
        `DELETE FROM ${table}
          WHERE org_id = $1::uuid AND store_id = $2::uuid AND batch_id = $3::uuid`,
        [DEMO_ORG_ID, DEMO_STORE_ID, rows.batchId],
      );
    }
    await client.query(
      `DELETE FROM garment_incidents
        WHERE org_id = $1::uuid AND store_id = $2::uuid AND garment_id = ANY($3::uuid[])`,
      [DEMO_ORG_ID, DEMO_STORE_ID, rows.garmentIds],
    );
    await client.query(
      `DELETE FROM garment_status_log
        WHERE org_id = $1::uuid AND store_id = $2::uuid AND garment_id = ANY($3::uuid[])`,
      [DEMO_ORG_ID, DEMO_STORE_ID, rows.garmentIds],
    );
    await client.query(
      `DELETE FROM production_batches
        WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
      [DEMO_ORG_ID, DEMO_STORE_ID, rows.batchId],
    );
    await client.query(
      `DELETE FROM garments
        WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = ANY($3::uuid[])`,
      [DEMO_ORG_ID, DEMO_STORE_ID, rows.garmentIds],
    );
    await client.query(
      `DELETE FROM order_lines
        WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = ANY($3::uuid[])`,
      [DEMO_ORG_ID, DEMO_STORE_ID, rows.lineIds],
    );
    await client.query(
      `DELETE FROM orders
        WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = ANY($3::uuid[])`,
      [DEMO_ORG_ID, DEMO_STORE_ID, rows.orderIds],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertDiscrepantAttempt(
  client: SqlClient,
  rows: Fixture,
  attemptId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO production_handoff_attempts (
       id, org_id, store_id, batch_id, batch_version, checkpoint, attempt_no, outcome,
       expected_count, scanned_count, matched_count, missing_count, unexpected_count,
       staff_id, device_id, recorded_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 'store_dispatch', 1, 'discrepancy',
       2, 1, 1, 1, 0, $5::uuid, $6::uuid, statement_timestamp()
     )`,
    [attemptId, DEMO_ORG_ID, DEMO_STORE_ID, rows.batchId, DEMO_STAFF_A_ID, DEVICE],
  );
  for (const [index, outcome] of ["matched", "missing"].entries()) {
    await client.query(
      `INSERT INTO production_handoff_attempt_items (
         id, org_id, store_id, batch_id, attempt_id, checkpoint,
         garment_id, barcode, outcome, recorded_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'store_dispatch',
         $6::uuid, $7, $8, statement_timestamp()
       )`,
      [
        randomUUID(),
        DEMO_ORG_ID,
        DEMO_STORE_ID,
        rows.batchId,
        attemptId,
        rows.garmentIds[index],
        rows.barcodes[index],
        outcome,
      ],
    );
  }
}

async function resolveProjection(
  client: SqlClient,
  rows: Fixture,
  attemptId: string,
  swapped: boolean,
): Promise<void> {
  const matchedId = rows.garmentIds[0]!;
  const missingId = rows.garmentIds[1]!;
  await client.query(
    `UPDATE garments
        SET custody_state = CASE
              WHEN id = $4::uuid THEN $6
              WHEN id = $5::uuid THEN $7
              ELSE custody_state
            END,
            status = CASE WHEN id = $4::uuid AND $8::boolean THEN 'washing' ELSE status END
      WHERE org_id = $1::uuid AND store_id = $2::uuid
        AND id = ANY($3::uuid[])`,
    [
      DEMO_ORG_ID,
      DEMO_STORE_ID,
      rows.garmentIds,
      swapped ? missingId : matchedId,
      swapped ? matchedId : missingId,
      "to_factory",
      "exception",
      true,
    ],
  );
  const exceptionId = swapped ? matchedId : missingId;
  await client.query(
    `UPDATE batch_garments
        SET state = 'exception', updated_by_staff_id = $4::uuid,
            updated_by_device_id = $5::uuid, updated_at = statement_timestamp()
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND batch_id = $3::uuid
        AND garment_id = $6::uuid`,
    [DEMO_ORG_ID, DEMO_STORE_ID, rows.batchId, DEMO_STAFF_A_ID, DEVICE, exceptionId],
  );
  await client.query(
    `INSERT INTO production_handoff_discrepancy_resolutions (
       id, org_id, store_id, batch_id, checkpoint, attempt_id,
       resolution_code, staff_id, device_id, resolved_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'store_dispatch', $5::uuid,
       'exception_accepted', $6::uuid, $7::uuid, statement_timestamp()
     )`,
    [randomUUID(), DEMO_ORG_ID, DEMO_STORE_ID, rows.batchId, attemptId, DEMO_STAFF_A_ID, DEVICE],
  );
  await client.query(
    `INSERT INTO production_handoff_checkpoints (
       id, org_id, store_id, batch_id, checkpoint, attempt_id, outcome,
       matched_count, missing_count, unexpected_count, staff_id, device_id, completed_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'store_dispatch', $5::uuid, 'reconciled',
       1, 1, 0, $6::uuid, $7::uuid, statement_timestamp()
     )`,
    [randomUUID(), DEMO_ORG_ID, DEMO_STORE_ID, rows.batchId, attemptId, DEMO_STAFF_A_ID, DEVICE],
  );
  await client.query(
    `UPDATE production_batches
        SET status = 'store_dispatched', version = 2, exception_garment_count = 1,
            updated_by_staff_id = $4::uuid, updated_by_device_id = $5::uuid,
            updated_at = statement_timestamp()
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
    [DEMO_ORG_ID, DEMO_STORE_ID, rows.batchId, DEMO_STAFF_A_ID, DEVICE],
  );
}

async function tamperStoreDispatchWithoutLifecycle(
  client: SqlClient,
  rows: Fixture,
): Promise<void> {
  const attemptId = randomUUID();
  await client.query(
    `INSERT INTO production_handoff_attempts (
       id, org_id, store_id, batch_id, batch_version, checkpoint, attempt_no, outcome,
       expected_count, scanned_count, matched_count, missing_count, unexpected_count,
       staff_id, device_id, recorded_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, 'store_dispatch', 1, 'matched',
       1, 1, 1, 0, 0, $5::uuid, $6::uuid, statement_timestamp()
     )`,
    [attemptId, DEMO_ORG_ID, DEMO_STORE_ID, rows.batchId, DEMO_STAFF_A_ID, DEVICE],
  );
  await client.query(
    `INSERT INTO production_handoff_attempt_items (
       id, org_id, store_id, batch_id, attempt_id, checkpoint,
       garment_id, barcode, outcome, recorded_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'store_dispatch',
       $6::uuid, $7, 'matched', statement_timestamp()
     )`,
    [
      randomUUID(),
      DEMO_ORG_ID,
      DEMO_STORE_ID,
      rows.batchId,
      attemptId,
      rows.garmentIds[0],
      rows.barcodes[0],
    ],
  );
  await client.query(
    `UPDATE garments SET custody_state = 'to_factory'
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
    [DEMO_ORG_ID, DEMO_STORE_ID, rows.garmentIds[0]],
  );
  await client.query(
    `INSERT INTO production_handoff_checkpoints (
       id, org_id, store_id, batch_id, checkpoint, attempt_id, outcome,
       matched_count, missing_count, unexpected_count, staff_id, device_id, completed_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'store_dispatch', $5::uuid, 'matched',
       1, 0, 0, $6::uuid, $7::uuid, statement_timestamp()
     )`,
    [randomUUID(), DEMO_ORG_ID, DEMO_STORE_ID, rows.batchId, attemptId, DEMO_STAFF_A_ID, DEVICE],
  );
  await client.query(
    `UPDATE production_batches
        SET status = 'store_dispatched', version = 2,
            updated_by_staff_id = $4::uuid, updated_by_device_id = $5::uuid,
            updated_at = statement_timestamp()
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
    [DEMO_ORG_ID, DEMO_STORE_ID, rows.batchId, DEMO_STAFF_A_ID, DEVICE],
  );
}

test(
  "PostgreSQL binds custody advancement to lifecycle advancement and blocks active lost revival",
  { skip: pgUrls === null },
  async () => {
    assert.ok(pgUrls);
    const adminPool = createPgPool({ connectionString: pgUrls.admin });
    const appPool = createPgPool({ connectionString: pgUrls.app });
    const rows = fixture(1);
    try {
      await seedPgTestIdentityFixture(adminPool);
      await seedBaseRows(adminPool, rows, {
        batchStatus: "packing",
        garmentStatus: "received",
        custodyState: "store",
        qcStatus: "pending",
      });
      await assert.rejects(
        () =>
          withAppTransaction(appPool, (client) =>
            tamperStoreDispatchWithoutLifecycle(client, rows),
          ),
        (error: unknown) => {
          const failure = error as Readonly<{ code?: unknown; message?: unknown }>;
          assert.equal(failure.code, "23514");
          assert.match(String(failure.message), /factory member and garment graph disagree/u);
          return true;
        },
      );
      const result = await withAppTransaction(appPool, (client) =>
        recordPgFactoryCheckpoint(
          client,
          {
            org_id: DEMO_ORG_ID,
            store_id: DEMO_STORE_ID,
            staff_id: DEMO_STAFF_A_ID,
            device_id: DEVICE,
            at: 0,
            batch_id: rows.batchId,
            checkpoint: "store_dispatch",
            expected_version: 1,
            garment_ids: rows.garmentIds,
            scanned_barcodes: rows.barcodes,
          },
          randomUUID,
        ),
      );
      assert.deepEqual(result && { status: result.status, version: result.version }, {
        status: "store_dispatched",
        version: 2,
      });
      await assert.rejects(
        () =>
          withAppTransaction(appPool, async (client) => {
            await client.query(
              `UPDATE garments SET status = 'lost'
                WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
              [DEMO_ORG_ID, DEMO_STORE_ID, rows.garmentIds[0]],
            );
          }),
        (error: unknown) => {
          const failure = error as Readonly<{ code?: unknown; message?: unknown }>;
          assert.equal(failure.code, "23514");
          assert.match(String(failure.message), /factory member and garment graph disagree/u);
          return true;
        },
      );
    } finally {
      await cleanupFixture(adminPool, rows);
      await Promise.all([appPool.end(), adminPool.end()]);
    }
  },
);

test(
  "PostgreSQL binds reconciled matched and missing evidence to each garment projection",
  { skip: pgUrls === null },
  async () => {
    assert.ok(pgUrls);
    const adminPool = createPgPool({ connectionString: pgUrls.admin });
    const appPool = createPgPool({ connectionString: pgUrls.app });
    const rows = fixture(2);
    const attemptId = randomUUID();
    try {
      await seedPgTestIdentityFixture(adminPool);
      await seedBaseRows(adminPool, rows, {
        batchStatus: "packing",
        garmentStatus: "received",
        custodyState: "store",
        qcStatus: "pending",
      });
      await withAppTransaction(appPool, (client) =>
        insertDiscrepantAttempt(client, rows, attemptId),
      );
      const resolveInput = Object.freeze({
        org_id: DEMO_ORG_ID,
        store_id: DEMO_STORE_ID,
        staff_id: DEMO_STAFF_A_ID,
        device_id: DEVICE,
        at: 0,
        batch_id: rows.batchId,
        attempt_id: attemptId,
        expected_version: 1,
        garment_ids: Object.freeze([rows.garmentIds[1]!]),
        reason_code: "exception_accepted" as const,
      });
      const summary = await withAppTransaction(appPool, (client) =>
        preparePgFactoryConfirmation(client, {
          operation: "discrepancy_resolve",
          input: resolveInput,
        }),
      );
      const authority = FactoryHandoffConfirmationSummarySchema.parse(summary);
      const pendingStore = createPgPendingActionStore(appPool);
      await withAppTransaction(appPool, async (client) => {
        const transaction = Object.freeze({ tenant, client });
        await pendingStore.lockPrivacy(transaction);
        await pendingStore.create(
          {
            nonce: randomUUID(),
            command: "fulfillment.handoff.discrepancy.resolve",
            commandVersion: "1.0.0",
            args: resolveInput,
            authority,
            entityVersions: Object.freeze([]),
            creatorStaffId: DEMO_STAFF_A_ID,
            orgId: DEMO_ORG_ID,
            storeId: DEMO_STORE_ID,
            idempotencyKey: randomUUID(),
            createdAt: Math.floor(Date.now() / 1_000),
            effectiveRisk: "R4",
            policyOutcome: "step_up",
            requiresOtherApprover: true,
          },
          transaction,
        );
      });
      await assert.rejects(
        () =>
          withAppTransaction(appPool, (client) => resolveProjection(client, rows, attemptId, true)),
        (error: unknown) => {
          const failure = error as Readonly<{ code?: unknown; message?: unknown }>;
          assert.equal(failure.code, "23514");
          assert.match(
            String(failure.message),
            /factory (?:checkpoint items and custody projection|exception projection) disagree/u,
          );
          return true;
        },
      );
      const afterTamper = await withAppTransaction(appPool, async (client) => {
        const batch = await client.query<Readonly<{ status: string; version: number }>>(
          `SELECT status, version FROM production_batches
              WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
          [DEMO_ORG_ID, DEMO_STORE_ID, rows.batchId],
        );
        const evidence = await client.query<Readonly<{ count: number }>>(
          `SELECT COUNT(*)::integer AS count
               FROM production_handoff_checkpoints
              WHERE org_id = $1::uuid AND store_id = $2::uuid AND batch_id = $3::uuid`,
          [DEMO_ORG_ID, DEMO_STORE_ID, rows.batchId],
        );
        return Object.freeze({ batch: batch.rows[0], checkpoints: evidence.rows[0]?.count });
      });
      assert.deepEqual(afterTamper, {
        batch: { status: "packing", version: 1 },
        checkpoints: 0,
      });
      await withAppTransaction(appPool, (client) =>
        resolveProjection(client, rows, attemptId, false),
      );
      const projected = await withAppTransaction(
        appPool,
        async (client) =>
          await client.query<
            Readonly<{ garment_id: string; state: string; custody_state: string }>
          >(
            `SELECT member.garment_id::text, member.state, garment.custody_state
               FROM batch_garments member
               JOIN garments garment
                 ON garment.org_id = member.org_id AND garment.store_id = member.store_id
                AND garment.id = member.garment_id
              WHERE member.org_id = $1::uuid AND member.store_id = $2::uuid
                AND member.batch_id = $3::uuid
              ORDER BY member.garment_id`,
            [DEMO_ORG_ID, DEMO_STORE_ID, rows.batchId],
          ),
      );
      const byId = new Map(projected.rows.map((row) => [row.garment_id, row]));
      assert.deepEqual(byId.get(rows.garmentIds[0]!), {
        garment_id: rows.garmentIds[0],
        state: "active",
        custody_state: "to_factory",
      });
      assert.deepEqual(byId.get(rows.garmentIds[1]!), {
        garment_id: rows.garmentIds[1],
        state: "exception",
        custody_state: "exception",
      });
    } finally {
      await cleanupFixture(adminPool, rows);
      await Promise.all([appPool.end(), adminPool.end()]);
    }
  },
);

test(
  "PostgreSQL permits a repeated rework projection only with a newer QC evidence row",
  { skip: pgUrls === null },
  async () => {
    assert.ok(pgUrls);
    const adminPool = createPgPool({ connectionString: pgUrls.admin });
    const appPool = createPgPool({ connectionString: pgUrls.app });
    const rows = fixture(1);
    try {
      await seedPgTestIdentityFixture(adminPool);
      await seedBaseRows(adminPool, rows, {
        batchStatus: "factory_received",
        garmentStatus: "reworked",
        custodyState: "factory",
        qcStatus: "rework",
      });
      const detail = await withPoolClient(appPool, (client) =>
        withTenantTransaction(
          client,
          tenant,
          (transaction) => getPgFactoryBatch(transaction, DEMO_ORG_ID, DEMO_STORE_ID, rows.batchId),
          { isolation: "repeatable_read", readOnly: true },
        ),
      );
      assert.equal(detail?.batch.batch_id, rows.batchId);
      assert.equal(detail?.batch.version, 1);
      const fixtureClient = await adminPool.connect();
      try {
        await fixtureClient.query("BEGIN");
        await fixtureClient.query("SET LOCAL session_replication_role = 'replica'");
        await fixtureClient.query(
          `INSERT INTO garment_qc_log (
             id, org_id, store_id, batch_id, order_id, garment_id, inspection_no,
             outcome, reason_code, staff_id, device_id, inspected_at
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 1,
             'rework', 'stain_remaining', $7::uuid, $8::uuid, $9
           )`,
          [
            randomUUID(),
            DEMO_ORG_ID,
            DEMO_STORE_ID,
            rows.batchId,
            rows.orderIds[0],
            rows.garmentIds[0],
            DEMO_STAFF_A_ID,
            DEVICE,
            new Date(Date.now() - 30_000),
          ],
        );
        await fixtureClient.query("COMMIT");
      } catch (error) {
        await fixtureClient.query("ROLLBACK");
        throw error;
      } finally {
        fixtureClient.release();
      }
      const result = await withAppTransaction(appPool, (client) =>
        recordPgFactoryQuality(
          client,
          {
            org_id: DEMO_ORG_ID,
            store_id: DEMO_STORE_ID,
            staff_id: DEMO_STAFF_A_ID,
            device_id: DEVICE,
            at: 0,
            batch_id: rows.batchId,
            expected_version: 1,
            garment_ids: Object.freeze([rows.garmentIds[0]!]),
            checks: Object.freeze([
              Object.freeze({
                garment_id: rows.garmentIds[0]!,
                outcome: "rework" as const,
                reason_code: "finish_incomplete" as const,
              }),
            ]),
          },
          randomUUID,
        ),
      );
      assert.equal(result?.version, 2);
      const evidence = await withAppTransaction(
        appPool,
        async (client) =>
          await client.query<Readonly<{ count: number; max_inspection: number }>>(
            `SELECT COUNT(*)::integer AS count, MAX(inspection_no)::integer AS max_inspection
               FROM garment_qc_log
              WHERE org_id = $1::uuid AND store_id = $2::uuid
                AND batch_id = $3::uuid AND garment_id = $4::uuid`,
            [DEMO_ORG_ID, DEMO_STORE_ID, rows.batchId, rows.garmentIds[0]],
          ),
      );
      assert.deepEqual(evidence.rows[0], { count: 2, max_inspection: 2 });
    } finally {
      await cleanupFixture(adminPool, rows);
      await Promise.all([appPool.end(), adminPool.end()]);
    }
  },
);
