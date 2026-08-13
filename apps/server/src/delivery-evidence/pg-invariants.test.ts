import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPgPool, resolvePgUrls, type PgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { DEMO_ADMIN_ID, DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { PG_TEST_STAFF_B_ID, seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { createPgDeliveryEvidenceStore } from "./pg-store.js";

const pgUrls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;

type Fixture = Readonly<{
  orderId: string;
  laundryOrderId: string;
  customerId: string;
  appointmentId: string;
  taskId: string;
  attachmentId: string;
  evidenceId: string;
}>;

const fixture = (): Fixture =>
  Object.freeze({
    orderId: randomUUID(),
    laundryOrderId: randomUUID(),
    customerId: randomUUID(),
    appointmentId: randomUUID(),
    taskId: randomUUID(),
    attachmentId: randomUUID(),
    evidenceId: randomUUID(),
  });

const tenant = (staffId: string): TenantContext =>
  Object.freeze({ orgId: DEMO_ORG_ID, storeId: DEMO_STORE_ID, staffId });

const withAppTransaction = <T>(
  pool: PgPool,
  staffId: string,
  operation: (client: SqlClient) => Promise<T>,
): Promise<T> =>
  withPoolClient(pool, (client) => withTenantTransaction(client, tenant(staffId), operation));

function rejectsWith(code: string, message: RegExp) {
  return (error: unknown): boolean => {
    const pgError = error as Readonly<{ code?: unknown; message?: unknown }>;
    assert.equal(pgError.code, code);
    assert.match(String(pgError.message), message);
    return true;
  };
}

async function seed(pool: PgPool, rows: Fixture): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(
      `INSERT INTO delivery_orders (
         id, org_id, store_id, laundry_order_id, customer_id,
         collection_method, return_method, pickup_appointment_id,
         pickup_fee_cents, return_fee_cents, total_fee_cents,
         status, version, created_at, updated_at,
         created_by_staff_id, updated_by_staff_id
       ) VALUES (
         $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,
         'pickup','self_pickup',$6::uuid,800,0,800,
         'pickup_in_progress',4,now() - interval '2 minutes',now() - interval '1 minute',
         $7::uuid,$7::uuid
       )`,
      [
        rows.orderId,
        DEMO_ORG_ID,
        DEMO_STORE_ID,
        rows.laundryOrderId,
        rows.customerId,
        rows.appointmentId,
        DEMO_ADMIN_ID,
      ],
    );
    await client.query(
      `INSERT INTO delivery_tasks (
         id, org_id, store_id, delivery_order_id, leg, assignee_staff_id,
         assigned_by_staff_id, source, status, version, accepted_at,
         created_at, updated_at, created_by_staff_id, updated_by_staff_id
       ) VALUES (
         $1::uuid,$2::uuid,$3::uuid,$4::uuid,'pickup',$5::uuid,
         $6::uuid,'assignment','accepted',2,now() - interval '1 minute',
         now() - interval '2 minutes',now() - interval '1 minute',$6::uuid,$5::uuid
       )`,
      [rows.taskId, DEMO_ORG_ID, DEMO_STORE_ID, rows.orderId, DEMO_STAFF_A_ID, DEMO_ADMIN_ID],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function cleanup(pool: PgPool, rows: Fixture): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(
      "DELETE FROM delivery_evidence_attachment_links WHERE delivery_evidence_id = $1::uuid",
      [rows.evidenceId],
    );
    await client.query("DELETE FROM delivery_evidence_events WHERE id = $1::uuid", [
      rows.evidenceId,
    ]);
    await client.query("DELETE FROM delivery_evidence_attachments WHERE id = $1::uuid", [
      rows.attachmentId,
    ]);
    await client.query("DELETE FROM delivery_tasks WHERE id = $1::uuid", [rows.taskId]);
    await client.query("DELETE FROM delivery_orders WHERE id = $1::uuid", [rows.orderId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

test(
  "real PostgreSQL delivery evidence is accepted-assignee-only, append-only and completes atomically",
  { skip: pgUrls === null },
  async () => {
    assert.ok(pgUrls);
    const adminPool = createPgPool({ connectionString: pgUrls.admin });
    const appPool = createPgPool({ connectionString: pgUrls.app });
    const rows = fixture();
    let seeded = false;
    try {
      await seedPgTestIdentityFixture(adminPool);
      await seed(adminPool, rows);
      seeded = true;
      const store = createPgDeliveryEvidenceStore(appPool);
      const at = Math.floor(Date.now() / 1_000);

      await assert.rejects(
        () =>
          withAppTransaction(appPool, DEMO_STAFF_A_ID, async (client) => {
            await client.query(
              `UPDATE delivery_orders SET status = 'picked_up', version = version + 1,
                 updated_by_staff_id = $4::uuid
               WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
              [DEMO_ORG_ID, DEMO_STORE_ID, rows.orderId, DEMO_STAFF_A_ID],
            );
          }),
        rejectsWith("23514", /completion requires current evidence/iu),
      );

      const upload = Object.freeze({
        attachment_id: rows.attachmentId,
        org_id: DEMO_ORG_ID,
        store_id: DEMO_STORE_ID,
        staff_id: DEMO_STAFF_A_ID,
        delivery_order_id: rows.orderId,
        delivery_task_id: rows.taskId,
        leg: "pickup" as const,
        expected_delivery_task_version: 2,
        kind: "photo" as const,
        storage_key: `delivery-${randomUUID()}.jpg`,
        content_type: "image/jpeg" as const,
        content_sha256: "a".repeat(64),
        byte_size: 128,
        captured_at: at,
        at,
      });
      await assert.rejects(
        () => store.registerAttachment({ ...upload, staff_id: PG_TEST_STAFF_B_ID }),
        rejectsWith("42501", /current accepted assignee/iu),
      );
      const registered = await store.registerAttachment(upload);
      assert.equal(registered.ok, true);
      if (!registered.ok) return;
      assert.equal(registered.replay, false);
      const replay = await store.registerAttachment(upload);
      assert.equal(replay.ok, true);
      if (replay.ok) assert.equal(replay.replay, true);

      const body = Object.freeze({
        delivery_evidence_id: rows.evidenceId,
        delivery_order_id: rows.orderId,
        delivery_task_id: rows.taskId,
        leg: "pickup" as const,
        expected_delivery_order_version: 4,
        expected_delivery_task_version: 2,
        event_kind: "pickup" as const,
        outcome: "complete_leg" as const,
        captured_at: at,
        gps: Object.freeze({
          latitude_e7: 251_234_567,
          longitude_e7: 1_215_678_901,
          accuracy_mm: 3_000,
          captured_at: at,
        }),
        attachment_ids: [rows.attachmentId],
      });
      const authority = await store.prepare({
        ...body,
        org_id: DEMO_ORG_ID,
        store_id: DEMO_STORE_ID,
        staff_id: DEMO_STAFF_A_ID,
        at,
      });
      assert.notEqual(authority, null);
      if (authority === null) return;
      const completed = await store.record({
        ...body,
        org_id: DEMO_ORG_ID,
        store_id: DEMO_STORE_ID,
        staff_id: DEMO_STAFF_A_ID,
        at,
        authority,
      });
      assert.equal(completed.ok, true);
      if (!completed.ok) return;
      assert.equal(completed.delivery_order.status, "picked_up");
      assert.equal(completed.delivery_task.status, "completed");
      assert.equal(
        (await store.list(DEMO_ORG_ID, DEMO_STORE_ID, DEMO_STAFF_A_ID, rows.taskId, 50)).length,
        1,
      );
      assert.deepEqual(
        await store.list(DEMO_ORG_ID, DEMO_STORE_ID, PG_TEST_STAFF_B_ID, rows.taskId, 50),
        [],
      );

      await assert.rejects(
        () =>
          withAppTransaction(appPool, DEMO_STAFF_A_ID, async (client) => {
            await client.query(
              "UPDATE delivery_evidence_events SET accuracy_mm = 1 WHERE id = $1::uuid",
              [rows.evidenceId],
            );
          }),
        rejectsWith("42501", /permission denied|append-only/iu),
      );
      await assert.rejects(
        () =>
          withAppTransaction(appPool, DEMO_STAFF_A_ID, async (client) => {
            await client.query("TRUNCATE TABLE delivery_evidence_events");
          }),
        rejectsWith("42501", /permission denied|append-only/iu),
      );
    } finally {
      if (seeded) await cleanup(adminPool, rows);
      await Promise.all([appPool.end(), adminPool.end()]);
    }
  },
);
