import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPgPool, resolvePgUrls, type PgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { DEMO_ADMIN_ID, DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { createPgDeliveryTaskStore } from "../delivery-tasks/pg-store.js";
import { createPgDeliveryOrderStore } from "./pg-store.js";

const pgUrls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;

const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_STAFF_A_ID,
});

type Fixture = Readonly<{
  sourceCustomerId: string;
  rootCustomerId: string;
  nextRootCustomerId: string;
  unrelatedCustomerId: string;
  sourceAddressId: string;
  unrelatedAddressId: string;
  orderId: string;
  lineId: string;
  garmentId: string;
  appointmentId: string;
  badAppointmentId: string;
  deliveryOrderId: string;
  deliveryTaskId: string;
  deliveryEvidenceId: string;
  deliveryPhotoId: string;
  deliverySignatureId: string;
}>;

function fixture(): Fixture {
  return Object.freeze({
    sourceCustomerId: randomUUID(),
    rootCustomerId: randomUUID(),
    nextRootCustomerId: randomUUID(),
    unrelatedCustomerId: randomUUID(),
    sourceAddressId: randomUUID(),
    unrelatedAddressId: randomUUID(),
    orderId: randomUUID(),
    lineId: randomUUID(),
    garmentId: randomUUID(),
    appointmentId: randomUUID(),
    badAppointmentId: randomUUID(),
    deliveryOrderId: randomUUID(),
    deliveryTaskId: randomUUID(),
    deliveryEvidenceId: randomUUID(),
    deliveryPhotoId: randomUUID(),
    deliverySignatureId: randomUUID(),
  });
}

const withAppTransaction = <T>(
  pool: PgPool,
  operation: (client: SqlClient) => Promise<T>,
): Promise<T> => withPoolClient(pool, (client) => withTenantTransaction(client, TENANT, operation));

function rejectsWith(code: string, message: RegExp) {
  return (error: unknown): boolean => {
    const pgError = error as Readonly<{ code?: unknown; message?: unknown }>;
    assert.equal(pgError.code, code);
    assert.match(String(pgError.message), message);
    return true;
  };
}

async function seedReturnCompletionEvidence(pool: PgPool, rows: Fixture): Promise<void> {
  await withAppTransaction(pool, async (client) => {
    for (const [attachmentId, kind] of [
      [rows.deliveryPhotoId, "photo"],
      [rows.deliverySignatureId, "signature"],
    ] as const) {
      await client.query(
        `INSERT INTO delivery_evidence_attachments (
           id, org_id, store_id, delivery_order_id, delivery_task_id, leg,
           delivery_task_version, assignee_staff_id, kind, storage_key, content_type,
           content_sha256, byte_size, captured_at, expires_at, created_at, created_by_staff_id
         ) VALUES (
           $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'return',2,$6::uuid,$7,$8,
           'image/jpeg',$9,1,now(),now(),now(),$6::uuid
         )`,
        [
          attachmentId,
          DEMO_ORG_ID,
          DEMO_STORE_ID,
          rows.deliveryOrderId,
          rows.deliveryTaskId,
          DEMO_STAFF_A_ID,
          kind,
          `delivery-${attachmentId}.jpg`,
          kind === "photo" ? "a".repeat(64) : "b".repeat(64),
        ],
      );
    }
    await client.query(
      `INSERT INTO delivery_evidence_events (
         id, org_id, store_id, delivery_order_id, delivery_task_id, leg,
         delivery_task_version, assignee_staff_id, event_kind, outcome, captured_at,
         latitude_e7, longitude_e7, accuracy_mm, gps_captured_at, recorded_at,
         recorded_by_staff_id
       ) VALUES (
         $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,'return',2,$6::uuid,
         'delivered','complete_leg',now(),251234567,1215678901,3000,now(),now(),$6::uuid
       )`,
      [
        rows.deliveryEvidenceId,
        DEMO_ORG_ID,
        DEMO_STORE_ID,
        rows.deliveryOrderId,
        rows.deliveryTaskId,
        DEMO_STAFF_A_ID,
      ],
    );
    await client.query(
      `INSERT INTO delivery_evidence_attachment_links (
         org_id, store_id, delivery_evidence_id, attachment_id, linked_at, linked_by_staff_id
       ) SELECT $1::uuid,$2::uuid,$3::uuid,attachment_id,now(),$4::uuid
           FROM unnest($5::uuid[]) AS attachment_id`,
      [
        DEMO_ORG_ID,
        DEMO_STORE_ID,
        rows.deliveryEvidenceId,
        DEMO_STAFF_A_ID,
        [rows.deliveryPhotoId, rows.deliverySignatureId],
      ],
    );
  });
}

async function seed(adminPool: PgPool, rows: Fixture): Promise<void> {
  const client = await adminPool.connect();
  const start = new Date(Date.now() + 86_400_000);
  try {
    await client.query("BEGIN");
    const feature = await client.query<Readonly<{ delivery: boolean }>>(
      `UPDATE store_features SET delivery = true, updated_at = now()
        WHERE org_id = $1::uuid AND store_id = $2::uuid
        RETURNING delivery`,
      [DEMO_ORG_ID, DEMO_STORE_ID],
    );
    assert.equal(feature.rowCount, 1);
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(
      `INSERT INTO customers (
         id, org_id, phone, name, version, merged_into_id, merged_at, created_at, updated_at
       ) VALUES
         ($1::uuid,$5::uuid,$6,'Delivery Root',1,NULL,NULL,now(),now()),
         ($2::uuid,$5::uuid,$7,'Delivery Source',2,$1::uuid,now(),now(),now()),
         ($3::uuid,$5::uuid,$8,'Delivery Next Root',1,NULL,NULL,now(),now()),
         ($4::uuid,$5::uuid,$9,'Delivery Unrelated',1,NULL,NULL,now(),now())`,
      [
        rows.rootCustomerId,
        rows.sourceCustomerId,
        rows.nextRootCustomerId,
        rows.unrelatedCustomerId,
        DEMO_ORG_ID,
        `188${rows.rootCustomerId.replaceAll("-", "").slice(0, 8)}`,
        `189${rows.sourceCustomerId.replaceAll("-", "").slice(0, 8)}`,
        `186${rows.nextRootCustomerId.replaceAll("-", "").slice(0, 8)}`,
        `185${rows.unrelatedCustomerId.replaceAll("-", "").slice(0, 8)}`,
      ],
    );
    await client.query(
      `INSERT INTO customer_addresses (
         id, org_id, customer_id, profile_version, label, address_body,
         is_default, created_at, updated_at
       ) VALUES
         ($1::uuid,$5::uuid,$3::uuid,1,'来源地址','合成地址 A',true,now(),now()),
         ($2::uuid,$5::uuid,$4::uuid,1,'无关地址','合成地址 B',true,now(),now())`,
      [
        rows.sourceAddressId,
        rows.unrelatedAddressId,
        rows.sourceCustomerId,
        rows.unrelatedCustomerId,
        DEMO_ORG_ID,
      ],
    );
    await client.query(
      `INSERT INTO orders (
         id, org_id, store_id, ticket_no, status, customer_id, subtotal_cents,
         payable_cents, paid_cents, balance_cents, business_date,
         created_at, updated_at, created_by_staff_id
       ) VALUES (
         $1::uuid,$2::uuid,$3::uuid,$4,'open',$5::uuid,0,0,0,0,
         CURRENT_DATE,now(),now(),$6::uuid
       )`,
      [
        rows.orderId,
        DEMO_ORG_ID,
        DEMO_STORE_ID,
        `DELIVERY-${rows.orderId.slice(0, 8)}`,
        rows.sourceCustomerId,
        DEMO_STAFF_A_ID,
      ],
    );
    await client.query(
      `INSERT INTO order_lines (
         id, org_id, store_id, order_id, line_index, service_code,
         category_code, unit_price_cents, qty, line_total_cents
       ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,0,'wash','coat',0,1,0)`,
      [rows.lineId, DEMO_ORG_ID, DEMO_STORE_ID, rows.orderId],
    );
    await client.query(
      `INSERT INTO garments (
         id, org_id, store_id, order_id, order_line_id, seq, barcode,
         service_code, category_code, unit_price_cents, status, custody_state
       ) VALUES (
         $1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,1,$6,
         'wash','coat',0,'ready','store'
       )`,
      [
        rows.garmentId,
        DEMO_ORG_ID,
        DEMO_STORE_ID,
        rows.orderId,
        rows.lineId,
        `DELIVERY-${rows.garmentId}`,
      ],
    );
    await client.query(
      `INSERT INTO delivery_appointments (
         id, org_id, store_id, customer_id, address_id, direction, service_area_code,
         scheduled_start_at, scheduled_end_at, fee_cents, status, version, policy_version,
         created_at, updated_at, created_by_staff_id, updated_by_staff_id
       ) VALUES
         ($1::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,'return','north',
          $8,$9,900,'scheduled',1,1,now(),now(),$7::uuid,$7::uuid),
         ($2::uuid,$3::uuid,$4::uuid,$5::uuid,$10::uuid,'return','north',
          $8 + interval '2 hours',$9 + interval '2 hours',900,
          'scheduled',1,1,now(),now(),$7::uuid,$7::uuid)`,
      [
        rows.appointmentId,
        rows.badAppointmentId,
        DEMO_ORG_ID,
        DEMO_STORE_ID,
        rows.sourceCustomerId,
        rows.sourceAddressId,
        DEMO_STAFF_A_ID,
        start,
        new Date(start.getTime() + 3_600_000),
        rows.unrelatedAddressId,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function cleanup(adminPool: PgPool, rows: Fixture, deliveryBefore: boolean): Promise<void> {
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
    await client.query("DELETE FROM delivery_evidence_attachments WHERE id = ANY($1::uuid[])", [
      [rows.deliveryPhotoId, rows.deliverySignatureId],
    ]);
    await client.query("DELETE FROM delivery_tasks WHERE delivery_order_id = $1::uuid", [
      rows.deliveryOrderId,
    ]);
    await client.query("DELETE FROM delivery_orders WHERE laundry_order_id = $1::uuid", [
      rows.orderId,
    ]);
    await client.query("DELETE FROM delivery_appointments WHERE id = ANY($1::uuid[])", [
      [rows.appointmentId, rows.badAppointmentId],
    ]);
    await client.query("DELETE FROM garments WHERE id = $1::uuid", [rows.garmentId]);
    await client.query("DELETE FROM order_lines WHERE id = $1::uuid", [rows.lineId]);
    await client.query("DELETE FROM orders WHERE id = $1::uuid", [rows.orderId]);
    await client.query("DELETE FROM customer_addresses WHERE id = ANY($1::uuid[])", [
      [rows.sourceAddressId, rows.unrelatedAddressId],
    ]);
    await client.query("DELETE FROM customers WHERE id = ANY($1::uuid[])", [
      [
        rows.sourceCustomerId,
        rows.rootCustomerId,
        rows.nextRootCustomerId,
        rows.unrelatedCustomerId,
      ],
    ]);
    await client.query(
      `UPDATE store_features SET delivery = $3, updated_at = now()
        WHERE org_id = $1::uuid AND store_id = $2::uuid`,
      [DEMO_ORG_ID, DEMO_STORE_ID, deliveryBefore],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function createRequest(rows: Fixture, appointmentId = rows.appointmentId) {
  return Object.freeze({
    delivery_order_id: rows.deliveryOrderId,
    org_id: DEMO_ORG_ID,
    store_id: DEMO_STORE_ID,
    staff_id: DEMO_STAFF_A_ID,
    laundry_order_id: rows.orderId,
    customer_id: rows.sourceCustomerId,
    collection_method: "store_dropoff" as const,
    return_method: "delivery" as const,
    pickup_appointment_id: null,
    return_appointment_id: appointmentId,
    at: 946_684_800,
  });
}

test(
  "real PostgreSQL delivery order authority, CAS and terminal guards fail closed",
  { skip: pgUrls === null },
  async () => {
    assert.ok(pgUrls);
    const adminPool = createPgPool({ connectionString: pgUrls.admin });
    const appPool = createPgPool({ connectionString: pgUrls.app });
    const rows = fixture();
    let fixtureSeeded = false;
    let deliveryBefore = false;
    try {
      await seedPgTestIdentityFixture(adminPool);
      const before = await adminPool.query<Readonly<{ delivery: boolean }>>(
        `SELECT delivery FROM store_features
          WHERE org_id = $1::uuid AND store_id = $2::uuid`,
        [DEMO_ORG_ID, DEMO_STORE_ID],
      );
      deliveryBefore = before.rows[0]?.delivery ?? false;
      await seed(adminPool, rows);
      fixtureSeeded = true;
      const store = createPgDeliveryOrderStore(appPool);
      const taskStore = createPgDeliveryTaskStore(appPool);

      const badAddress = await store.create({
        ...createRequest(rows, rows.badAppointmentId),
        delivery_order_id: randomUUID(),
      });
      assert.deepEqual(badAddress, { ok: false, reason: "link_invalid" });

      const created = await store.create(createRequest(rows));
      assert.equal(created.ok, true);
      if (!created.ok) assert.fail("delivery order create failed");
      assert.equal(created.delivery_order.customer_id, rows.rootCustomerId);
      assert.equal(created.delivery_order.status, "at_store");
      assert.equal(created.delivery_order.total_fee_cents, 900);
      assert.ok(created.delivery_order.created_at > 946_684_800);
      assert.deepEqual(await store.create(createRequest(rows)), {
        ok: false,
        reason: "duplicate",
      });
      assert.equal(await store.get(DEMO_ORG_ID, randomUUID(), rows.deliveryOrderId), null);
      assert.equal(await store.get(randomUUID(), DEMO_STORE_ID, rows.deliveryOrderId), null);

      await assert.rejects(
        () =>
          withAppTransaction(appPool, (client) =>
            client.query(
              `UPDATE delivery_orders SET created_at = now(), status = 'return_scheduled',
                      version = 2, updated_by_staff_id = $4::uuid
                WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
              [DEMO_ORG_ID, DEMO_STORE_ID, rows.deliveryOrderId, DEMO_STAFF_A_ID],
            ),
          ),
        rejectsWith("42501", /identity is immutable/u),
      );
      await assert.rejects(
        () =>
          withAppTransaction(appPool, (client) =>
            client.query(
              `UPDATE delivery_orders SET status = 'completed', version = 2,
                      completed_at = now(), updated_by_staff_id = $4::uuid
                WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
              [DEMO_ORG_ID, DEMO_STORE_ID, rows.deliveryOrderId, DEMO_STAFF_A_ID],
            ),
          ),
        rejectsWith("23514", /illegal delivery order transition/u),
      );
      await assert.rejects(
        () =>
          withAppTransaction(appPool, (client) =>
            client.query(
              `UPDATE delivery_orders SET status = 'return_scheduled', version = 3,
                      updated_by_staff_id = $4::uuid
                WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
              [DEMO_ORG_ID, DEMO_STORE_ID, rows.deliveryOrderId, DEMO_STAFF_A_ID],
            ),
          ),
        rejectsWith("23514", /version must advance by one/u),
      );
      await assert.rejects(
        () =>
          withAppTransaction(appPool, (client) =>
            client.query(
              `UPDATE delivery_appointments SET status = 'cancelled', version = 2,
                      cancellation_reason = 'other', cancelled_at = now(),
                      cancelled_by_staff_id = $4::uuid, updated_by_staff_id = $4::uuid
                WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
              [DEMO_ORG_ID, DEMO_STORE_ID, rows.appointmentId, DEMO_STAFF_A_ID],
            ),
          ),
        rejectsWith("42501", /bound delivery appointment is immutable/u),
      );

      const admin = await adminPool.connect();
      try {
        await admin.query("BEGIN");
        await admin.query("SET LOCAL session_replication_role = 'replica'");
        await admin.query(
          `UPDATE customers SET merged_into_id = $2::uuid, merged_at = now(), version = 2
            WHERE id = $1::uuid`,
          [rows.rootCustomerId, rows.nextRootCustomerId],
        );
        await admin.query(
          `UPDATE store_features SET delivery = false, updated_at = now()
            WHERE org_id = $1::uuid AND store_id = $2::uuid`,
          [DEMO_ORG_ID, DEMO_STORE_ID],
        );
        await admin.query("COMMIT");
      } catch (error) {
        await admin.query("ROLLBACK");
        throw error;
      } finally {
        admin.release();
      }

      const disabledCreate = await store.create({
        ...createRequest(rows),
        delivery_order_id: randomUUID(),
      });
      assert.deepEqual(disabledCreate, { ok: false, reason: "feature_disabled" });
      const canonicalList = await store.list(DEMO_ORG_ID, DEMO_STORE_ID, {
        customer_id: rows.sourceCustomerId,
        limit: 10,
      });
      assert.equal(canonicalList.length, 1);
      const scheduleRequest = Object.freeze({
        org_id: DEMO_ORG_ID,
        store_id: DEMO_STORE_ID,
        staff_id: DEMO_STAFF_A_ID,
        delivery_order_id: rows.deliveryOrderId,
        customer_id: rows.sourceCustomerId,
        expected_version: 1,
        target_status: "return_scheduled",
        cancellation_reason: null,
        at: Math.floor(Date.now() / 1_000),
      });
      const concurrent = await Promise.all([
        store.transition(scheduleRequest),
        store.transition(scheduleRequest),
      ]);
      assert.equal(concurrent.filter(({ ok }) => ok).length, 1);
      assert.equal(
        concurrent.filter((result) => !result.ok && result.reason === "state_conflict").length,
        1,
      );
      const assigned = await taskStore.mutate({
        operation: "assign",
        org_id: DEMO_ORG_ID,
        store_id: DEMO_STORE_ID,
        staff_id: DEMO_ADMIN_ID,
        delivery_task_id: rows.deliveryTaskId,
        delivery_order_id: rows.deliveryOrderId,
        leg: "return",
        expected_delivery_order_version: 2,
        assignee_staff_id: DEMO_STAFF_A_ID,
        at: Math.floor(Date.now() / 1_000),
      });
      assert.equal(assigned.ok, true, "feature-off must not strand the scheduled return leg");
      const accepted = await taskStore.mutate({
        operation: "respond",
        org_id: DEMO_ORG_ID,
        store_id: DEMO_STORE_ID,
        staff_id: DEMO_STAFF_A_ID,
        delivery_order_id: rows.deliveryOrderId,
        leg: "return",
        delivery_task_id: rows.deliveryTaskId,
        expected_version: 1,
        expected_delivery_order_version: 2,
        decision: "accept",
        resolution_reason: null,
        at: Math.floor(Date.now() / 1_000),
      });
      assert.equal(accepted.ok, true);
      const inProgress = await store.transition({
        org_id: DEMO_ORG_ID,
        store_id: DEMO_STORE_ID,
        staff_id: DEMO_STAFF_A_ID,
        delivery_order_id: rows.deliveryOrderId,
        customer_id: rows.nextRootCustomerId,
        expected_version: 2,
        target_status: "return_in_progress",
        cancellation_reason: null,
        at: Math.floor(Date.now() / 1_000),
      });
      assert.equal(inProgress.ok && inProgress.delivery_order.status, "return_in_progress");

      await seedReturnCompletionEvidence(appPool, rows);

      await assert.rejects(
        () =>
          withAppTransaction(appPool, (client) =>
            client.query(
              `UPDATE delivery_orders SET status = 'completed', version = 4,
                      completed_at = now(), updated_by_staff_id = $4::uuid
                WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
              [DEMO_ORG_ID, DEMO_STORE_ID, rows.deliveryOrderId, DEMO_STAFF_A_ID],
            ),
          ),
        rejectsWith("23514", /laundry order is not terminal for delivery/u),
      );
      const terminalAdmin = await adminPool.connect();
      try {
        await terminalAdmin.query("BEGIN");
        await terminalAdmin.query("SET LOCAL session_replication_role = 'replica'");
        await terminalAdmin.query(
          `UPDATE garments SET status = 'delivered'
            WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
          [DEMO_ORG_ID, DEMO_STORE_ID, rows.garmentId],
        );
        await terminalAdmin.query(
          `UPDATE orders SET status = 'closed', updated_at = now()
            WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
          [DEMO_ORG_ID, DEMO_STORE_ID, rows.orderId],
        );
        await terminalAdmin.query("COMMIT");
      } catch (error) {
        await terminalAdmin.query("ROLLBACK");
        throw error;
      } finally {
        terminalAdmin.release();
      }
      const completed = await store.transition({
        org_id: DEMO_ORG_ID,
        store_id: DEMO_STORE_ID,
        staff_id: DEMO_STAFF_A_ID,
        delivery_order_id: rows.deliveryOrderId,
        customer_id: rows.sourceCustomerId,
        expected_version: 3,
        target_status: "completed",
        cancellation_reason: null,
        at: Math.floor(Date.now() / 1_000),
      });
      assert.equal(completed.ok && completed.delivery_order.status, "completed");
      assert.equal(
        (await taskStore.get(DEMO_ORG_ID, DEMO_STORE_ID, rows.deliveryTaskId))?.status,
        "completed",
      );
      await assert.rejects(
        () =>
          withAppTransaction(appPool, (client) =>
            client.query(
              `UPDATE delivery_orders SET status = 'cancelled', version = 5,
                      cancellation_reason = 'other', cancelled_at = now(),
                      updated_by_staff_id = $4::uuid
                WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
              [DEMO_ORG_ID, DEMO_STORE_ID, rows.deliveryOrderId, DEMO_STAFF_A_ID],
            ),
          ),
        rejectsWith("42501", /terminal delivery order is immutable/u),
      );
    } finally {
      if (fixtureSeeded) await cleanup(adminPool, rows, deliveryBefore);
      await appPool.end();
      await adminPool.end();
    }
  },
);
