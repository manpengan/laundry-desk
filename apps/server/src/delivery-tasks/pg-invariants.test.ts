import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPgPool, resolvePgUrls, type PgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import {
  DEMO_ADMIN_ID,
  DEMO_ORG_ID,
  DEMO_STAFF_A_ID,
  DEMO_STAFF_B_ID,
  DEMO_STORE_ID,
} from "../local/demo-ids.js";
import { PG_TEST_STAFF_B_ID, seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { createPgDeliveryTaskStore } from "./pg-store.js";

const pgUrls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;

type Fixture = Readonly<{
  pickupOrderId: string;
  cancelOrderId: string;
  pickupLaundryOrderId: string;
  cancelLaundryOrderId: string;
  pickupCustomerId: string;
  cancelCustomerId: string;
  pickupAppointmentId: string;
  cancelAppointmentId: string;
  taskId: string;
  successorTaskId: string;
  cancelTaskId: string;
  deliveryEvidenceId: string;
  deliveryPhotoId: string;
}>;

function fixture(): Fixture {
  return Object.freeze({
    pickupOrderId: randomUUID(),
    cancelOrderId: randomUUID(),
    pickupLaundryOrderId: randomUUID(),
    cancelLaundryOrderId: randomUUID(),
    pickupCustomerId: randomUUID(),
    cancelCustomerId: randomUUID(),
    pickupAppointmentId: randomUUID(),
    cancelAppointmentId: randomUUID(),
    taskId: randomUUID(),
    successorTaskId: randomUUID(),
    cancelTaskId: randomUUID(),
    deliveryEvidenceId: randomUUID(),
    deliveryPhotoId: randomUUID(),
  });
}

function tenant(staffId: string): TenantContext {
  return Object.freeze({ orgId: DEMO_ORG_ID, storeId: DEMO_STORE_ID, staffId });
}

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

async function seedPickupCompletionEvidence(pool: PgPool, rows: Fixture): Promise<void> {
  await withAppTransaction(pool, PG_TEST_STAFF_B_ID, async (client) => {
    await client.query(
      `INSERT INTO delivery_evidence_attachments (
         id, org_id, store_id, delivery_order_id, delivery_task_id, leg,
         delivery_task_version, assignee_staff_id, kind, storage_key, content_type,
         content_sha256, byte_size, captured_at, expires_at, created_at, created_by_staff_id
       ) VALUES (
         $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'pickup',2,$6::uuid,'photo',$7,
         'image/jpeg',$8,1,now(),now(),now(),$6::uuid
       )`,
      [
        rows.deliveryPhotoId,
        DEMO_ORG_ID,
        DEMO_STORE_ID,
        rows.pickupOrderId,
        rows.successorTaskId,
        PG_TEST_STAFF_B_ID,
        `delivery-${rows.deliveryPhotoId}.jpg`,
        "a".repeat(64),
      ],
    );
    await client.query(
      `INSERT INTO delivery_evidence_events (
         id, org_id, store_id, delivery_order_id, delivery_task_id, leg,
         delivery_task_version, assignee_staff_id, event_kind, outcome, captured_at,
         latitude_e7, longitude_e7, accuracy_mm, gps_captured_at, recorded_at,
         recorded_by_staff_id
       ) VALUES (
         $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'pickup',2,$6::uuid,
         'pickup','complete_leg',now(),251234567,1215678901,3000,now(),now(),$6::uuid
       )`,
      [
        rows.deliveryEvidenceId,
        DEMO_ORG_ID,
        DEMO_STORE_ID,
        rows.pickupOrderId,
        rows.successorTaskId,
        PG_TEST_STAFF_B_ID,
      ],
    );
    await client.query(
      `INSERT INTO delivery_evidence_attachment_links (
         org_id, store_id, delivery_evidence_id, attachment_id, linked_at, linked_by_staff_id
       ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,now(),$5::uuid)`,
      [
        DEMO_ORG_ID,
        DEMO_STORE_ID,
        rows.deliveryEvidenceId,
        rows.deliveryPhotoId,
        PG_TEST_STAFF_B_ID,
      ],
    );
  });
}

async function seed(adminPool: PgPool, rows: Fixture): Promise<void> {
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = 'replica'");
    for (const input of [
      {
        id: rows.pickupOrderId,
        laundryOrderId: rows.pickupLaundryOrderId,
        customerId: rows.pickupCustomerId,
        appointmentId: rows.pickupAppointmentId,
      },
      {
        id: rows.cancelOrderId,
        laundryOrderId: rows.cancelLaundryOrderId,
        customerId: rows.cancelCustomerId,
        appointmentId: rows.cancelAppointmentId,
      },
    ]) {
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
           'pickup_scheduled',1,now(),now(),$7::uuid,$7::uuid
         )`,
        [
          input.id,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          input.laundryOrderId,
          input.customerId,
          input.appointmentId,
          DEMO_ADMIN_ID,
        ],
      );
    }
    await client.query(
      `UPDATE store_features SET delivery = false, updated_at = now()
        WHERE org_id = $1::uuid AND store_id = $2::uuid`,
      [DEMO_ORG_ID, DEMO_STORE_ID],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function cleanup(adminPool: PgPool, rows: Fixture): Promise<void> {
  const client = await adminPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(
      "DELETE FROM delivery_evidence_attachment_links WHERE delivery_evidence_id = $1::uuid",
      [rows.deliveryEvidenceId],
    );
    await client.query("DELETE FROM delivery_evidence_events WHERE id = $1::uuid", [
      rows.deliveryEvidenceId,
    ]);
    await client.query("DELETE FROM delivery_evidence_attachments WHERE id = $1::uuid", [
      rows.deliveryPhotoId,
    ]);
    await client.query("DELETE FROM delivery_tasks WHERE delivery_order_id = ANY($1::uuid[])", [
      [rows.pickupOrderId, rows.cancelOrderId],
    ]);
    await client.query("DELETE FROM delivery_orders WHERE id = ANY($1::uuid[])", [
      [rows.pickupOrderId, rows.cancelOrderId],
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function assignRequest(rows: Fixture, order: "pickup" | "cancel") {
  return Object.freeze({
    operation: "assign" as const,
    org_id: DEMO_ORG_ID,
    store_id: DEMO_STORE_ID,
    staff_id: DEMO_ADMIN_ID,
    delivery_task_id: order === "pickup" ? rows.taskId : rows.cancelTaskId,
    delivery_order_id: order === "pickup" ? rows.pickupOrderId : rows.cancelOrderId,
    leg: "pickup" as const,
    expected_delivery_order_version: 1,
    assignee_staff_id: DEMO_STAFF_A_ID,
    at: 946_684_800,
  });
}

test(
  "real PostgreSQL task custody, deferred completeness, RLS and order sync fail closed",
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
      const store = createPgDeliveryTaskStore(appPool);

      const ordinaryAssignment = await store.mutate({
        ...assignRequest(rows, "pickup"),
        staff_id: DEMO_STAFF_A_ID,
      });
      assert.deepEqual(ordinaryAssignment, { ok: false, reason: "state_conflict" });
      const inactiveAssignment = await store.mutate({
        ...assignRequest(rows, "pickup"),
        assignee_staff_id: randomUUID(),
      });
      assert.deepEqual(inactiveAssignment, { ok: false, reason: "state_conflict" });

      const assigned = await store.mutate(assignRequest(rows, "pickup"));
      assert.equal(assigned.ok, true, "feature-off must not strand an existing scheduled leg");
      if (!assigned.ok) return;
      assert.equal(assigned.delivery_task.status, "offered");
      assert.notEqual(assigned.delivery_task.created_at, assignRequest(rows, "pickup").at);

      const stale = await store.mutate({
        ...assignRequest(rows, "pickup"),
        delivery_task_id: randomUUID(),
        expected_delivery_order_version: 2,
      });
      assert.deepEqual(stale, { ok: false, reason: "state_conflict" });

      await withAppTransaction(appPool, DEMO_STAFF_A_ID, async (client) => {
        const accepted = await client.query(
          `UPDATE delivery_tasks SET status = 'accepted', version = version + 1,
             updated_by_staff_id = $4::uuid
           WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
          [DEMO_ORG_ID, DEMO_STORE_ID, rows.taskId, DEMO_STAFF_A_ID],
        );
        assert.equal(accepted.rowCount, 1);
      });

      for (const status of ["transferred", "taken_over"] as const) {
        await assert.rejects(
          () =>
            withAppTransaction(appPool, DEMO_ADMIN_ID, async (client) => {
              await client.query(
                `UPDATE delivery_tasks SET status = $4, version = version + 1,
                   resolution_reason = 'other', updated_by_staff_id = $5::uuid
                 WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
                [DEMO_ORG_ID, DEMO_STORE_ID, rows.taskId, status, DEMO_ADMIN_ID],
              );
            }),
          rejectsWith("23514", /terminal reassignment requires successor task/iu),
        );
      }
      assert.equal((await store.get(DEMO_ORG_ID, DEMO_STORE_ID, rows.taskId))?.status, "accepted");

      const transferred = await store.mutate({
        operation: "transfer",
        org_id: DEMO_ORG_ID,
        store_id: DEMO_STORE_ID,
        staff_id: DEMO_ADMIN_ID,
        delivery_order_id: rows.pickupOrderId,
        leg: "pickup",
        delivery_task_id: rows.taskId,
        successor_task_id: rows.successorTaskId,
        expected_version: 2,
        expected_delivery_order_version: 1,
        target_staff_id: PG_TEST_STAFF_B_ID,
        resolution_reason: "shift_end",
        at: 946_684_801,
      });
      assert.equal(transferred.ok, true);
      if (!transferred.ok) return;
      assert.equal(transferred.previous_task?.status, "transferred");
      assert.equal(transferred.delivery_task.predecessor_task_id, rows.taskId);

      await withAppTransaction(appPool, PG_TEST_STAFF_B_ID, async (client) => {
        await client.query(
          `UPDATE delivery_tasks SET status = 'accepted', version = version + 1,
             updated_by_staff_id = $4::uuid
           WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
          [DEMO_ORG_ID, DEMO_STORE_ID, rows.successorTaskId, PG_TEST_STAFF_B_ID],
        );
      });
      await assert.rejects(
        () =>
          withAppTransaction(appPool, PG_TEST_STAFF_B_ID, async (client) => {
            await client.query(
              `UPDATE delivery_tasks SET status = 'completed', version = version + 1,
                 updated_by_staff_id = $4::uuid
               WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
              [DEMO_ORG_ID, DEMO_STORE_ID, rows.successorTaskId, PG_TEST_STAFF_B_ID],
            );
          }),
        rejectsWith("23514", /terminal task must follow delivery order truth/iu),
      );

      await assert.rejects(
        () =>
          withAppTransaction(appPool, DEMO_STAFF_A_ID, async (client) => {
            await client.query(
              `UPDATE delivery_orders SET status = 'pickup_in_progress', version = version + 1,
                 updated_by_staff_id = $4::uuid
               WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
              [DEMO_ORG_ID, DEMO_STORE_ID, rows.pickupOrderId, DEMO_STAFF_A_ID],
            );
          }),
        rejectsWith("23514", /requires accepted assignee task/iu),
      );
      await withAppTransaction(appPool, PG_TEST_STAFF_B_ID, async (client) => {
        const updated = await client.query(
          `UPDATE delivery_orders SET status = 'pickup_in_progress', version = version + 1,
             updated_by_staff_id = $4::uuid
           WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
          [DEMO_ORG_ID, DEMO_STORE_ID, rows.pickupOrderId, PG_TEST_STAFF_B_ID],
        );
        assert.equal(updated.rowCount, 1);
      });
      await seedPickupCompletionEvidence(appPool, rows);
      await withAppTransaction(appPool, PG_TEST_STAFF_B_ID, async (client) => {
        const updated = await client.query(
          `UPDATE delivery_orders SET status = 'picked_up', version = version + 1,
             updated_by_staff_id = $4::uuid
           WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
          [DEMO_ORG_ID, DEMO_STORE_ID, rows.pickupOrderId, PG_TEST_STAFF_B_ID],
        );
        assert.equal(updated.rowCount, 1);
      });
      const completed = await store.get(DEMO_ORG_ID, DEMO_STORE_ID, rows.successorTaskId);
      assert.equal(completed?.status, "completed");
      assert.notEqual(completed?.completed_at, null);

      const cancelAssigned = await store.mutate(assignRequest(rows, "cancel"));
      assert.equal(cancelAssigned.ok, true);
      await assert.rejects(
        () =>
          withAppTransaction(appPool, DEMO_ADMIN_ID, async (client) => {
            await client.query(
              `UPDATE delivery_tasks SET status = 'cancelled', version = version + 1,
                 updated_by_staff_id = $4::uuid
               WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
              [DEMO_ORG_ID, DEMO_STORE_ID, rows.cancelTaskId, DEMO_ADMIN_ID],
            );
          }),
        rejectsWith("23514", /terminal task must follow delivery order truth/iu),
      );
      await withAppTransaction(appPool, DEMO_ADMIN_ID, async (client) => {
        await client.query(
          `UPDATE delivery_orders SET status = 'cancelled', version = version + 1,
             cancellation_reason = 'store_request', updated_by_staff_id = $4::uuid
           WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
          [DEMO_ORG_ID, DEMO_STORE_ID, rows.cancelOrderId, DEMO_ADMIN_ID],
        );
      });
      assert.equal(
        (await store.get(DEMO_ORG_ID, DEMO_STORE_ID, rows.cancelTaskId))?.status,
        "cancelled",
      );

      const otherStore = await store.list(DEMO_ORG_ID, randomUUID(), {
        active_only: false,
        limit: 100,
      });
      assert.deepEqual(otherStore, []);
      await assert.rejects(
        () =>
          withAppTransaction(appPool, DEMO_STAFF_B_ID, async (client) => {
            await client.query(
              `UPDATE delivery_tasks SET status = 'accepted', version = version + 1,
                 updated_by_staff_id = $4::uuid
               WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
              [DEMO_ORG_ID, DEMO_STORE_ID, rows.successorTaskId, DEMO_STAFF_B_ID],
            );
          }),
        rejectsWith("42501", /terminal delivery task is immutable/iu),
      );
      await assert.rejects(
        () =>
          withAppTransaction(appPool, DEMO_ADMIN_ID, async (client) => {
            await client.query(
              `DELETE FROM delivery_tasks
                WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
              [DEMO_ORG_ID, DEMO_STORE_ID, rows.cancelTaskId],
            );
          }),
        rejectsWith("42501", /permission denied/iu),
      );
      await assert.rejects(
        () =>
          withAppTransaction(appPool, DEMO_ADMIN_ID, async (client) => {
            await client.query("TRUNCATE TABLE delivery_tasks");
          }),
        rejectsWith("42501", /permission denied/iu),
      );
      assert.notEqual(DEMO_STAFF_B_ID, PG_TEST_STAFF_B_ID);
    } finally {
      if (seeded) await cleanup(adminPool, rows);
      await Promise.all([appPool.end(), adminPool.end()]);
    }
  },
);
