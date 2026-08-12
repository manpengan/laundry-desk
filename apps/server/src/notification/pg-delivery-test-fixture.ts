import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import type { NotificationDeliveryBatchEnqueueResult } from "@laundry/contracts";

import { executeCommand } from "../bus/executor.js";
import { createPgIdempotencyStore } from "../bus/pg-idempotency.js";
import type { ActorContext } from "../bus/types.js";
import type { PgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { createPgPendingActionStore } from "../pending-actions/pg-store.js";
import { SOFTWARE_ONLY_NOTIFICATION_CAPABILITY } from "./delivery-provider.js";
import { createPgNotificationDeliveryStore } from "./pg-delivery-store.js";
import { createPgNotificationStore } from "./pg-store.js";

const DAY_MS = 86_400_000;
const TEMPLATE_BODY =
  "您好，您的洗衣订单{{tickets}}共{{garment_count}}件已可取，尚欠{{balance_cents}}分，请方便时到店取衣。";

export type NotificationPgFixture = Readonly<{
  tenant: TenantContext;
  actor: ActorContext;
  code: string;
}>;

export type NotificationPgCandidate = Readonly<{
  customerId: string;
  orderId: string;
  phone: string;
  ticket: string;
}>;

export function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return Object.freeze({ promise, resolve });
}

export async function seedNotificationTenant(adminPool: PgPool): Promise<NotificationPgFixture> {
  const orgId = randomUUID();
  const storeId = randomUUID();
  const staffId = randomUUID();
  const code = orgId.slice(0, 8);
  await adminPool.query("BEGIN");
  try {
    await adminPool.query(
      `INSERT INTO orgs (id, code, name, created_at, updated_at)
       VALUES ($1::uuid, $2, 'Notification Test Org', now(), now())`,
      [orgId, `notify-${code}`],
    );
    await adminPool.query(
      `INSERT INTO notification_templates (
         id, org_id, code, version, channel, body, status, created_at
       ) VALUES (
         $1::uuid, $2::uuid, 'pickup_reminder_v1', 1, 'sms', $3, 'active', now()
       )`,
      [randomUUID(), orgId, TEMPLATE_BODY],
    );
    await adminPool.query(
      `INSERT INTO stores (id, org_id, code, name, timezone, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'Notification Test Store',
               'Asia/Shanghai', now(), now())`,
      [storeId, orgId, `store-${code}`],
    );
    await adminPool.query(
      `INSERT INTO staffs (
         id, org_id, username, password_hash, pin_hash, display_name,
         is_active, permission_version, created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3, 'test-password-hash', 'test-pin-hash',
         'Notification Admin', true, 1, now(), now()
       )`,
      [staffId, orgId, `admin-${code}`],
    );
    await adminPool.query(
      `INSERT INTO staff_store_roles (
         id, org_id, store_id, staff_id, role, is_active, is_privacy_admin,
         created_at, updated_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'admin', true, true, now(), now()
       )`,
      [randomUUID(), orgId, storeId, staffId],
    );
    await adminPool.query("COMMIT");
  } catch (error) {
    await adminPool.query("ROLLBACK");
    throw error;
  }
  return Object.freeze({
    tenant: Object.freeze({ orgId, storeId, staffId }),
    actor: Object.freeze({
      staffId,
      deviceId: null,
      via: "ui" as const,
      permissions: Object.freeze(["customer_read", "notification_send"]),
    }),
    code,
  });
}

export async function seedNotificationCandidate(
  appPool: PgPool,
  fixture: NotificationPgFixture,
  index: number,
  now: Date,
): Promise<NotificationPgCandidate> {
  const customerId = randomUUID();
  const orderId = randomUUID();
  const lineId = randomUUID();
  const garmentId = randomUUID();
  const phone = `139${String(index).padStart(8, "0")}`;
  const ticket = `OUTBOX-${fixture.code}-${index}`;
  const createdAt = new Date(now.getTime() - 200 * DAY_MS);
  await withPoolClient(appPool, (client) =>
    withTenantTransaction(client, fixture.tenant, async (tx) => {
      await tx.query(
        `INSERT INTO customers (id, org_id, phone, name, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, $4, $5::timestamptz, $5::timestamptz)`,
        [customerId, fixture.tenant.orgId, phone, `Notification Customer ${index}`, createdAt],
      );
      await tx.query(
        `INSERT INTO orders (
           id, org_id, store_id, ticket_no, status, customer_id, customer_phone,
           customer_name, subtotal_cents, payable_cents, paid_cents, balance_cents,
           created_at, updated_at, created_by_staff_id, business_date
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, 'open', $5::uuid, $6, $7,
           500, 500, 0, 500, $8::timestamptz, $8::timestamptz,
           $9::uuid, $10::date
         )`,
        [
          orderId,
          fixture.tenant.orgId,
          fixture.tenant.storeId,
          ticket,
          customerId,
          phone,
          `Notification Customer ${index}`,
          createdAt,
          fixture.tenant.staffId,
          createdAt.toISOString().slice(0, 10),
        ],
      );
      await tx.query(
        `INSERT INTO order_lines (
           id, org_id, store_id, order_id, line_index, service_code,
           category_code, unit_price_cents, qty, line_total_cents
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, 0,
           'wash', 'coat', 500, 1, 500
         )`,
        [lineId, fixture.tenant.orgId, fixture.tenant.storeId, orderId],
      );
      await tx.query(
        `INSERT INTO garments (
           id, org_id, store_id, order_id, order_line_id, seq, barcode,
           service_code, category_code, unit_price_cents, status,
           rack_zone, rack_slot, racked_at, racked_by_staff_id
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 1, $6,
           'wash', 'coat', 500, 'racked', 'N', $7,
           $8::timestamptz, $9::uuid
         )`,
        [
          garmentId,
          fixture.tenant.orgId,
          fixture.tenant.storeId,
          orderId,
          lineId,
          `OUTBOX-${garmentId}`,
          String(index),
          createdAt,
          fixture.tenant.staffId,
        ],
      );
    }),
  );
  return Object.freeze({ customerId, orderId, phone, ticket });
}

export async function enqueueNotificationBatch(
  appPool: PgPool,
  fixture: NotificationPgFixture,
  orderId: string,
  now: Date,
  deliveryStore: ReturnType<typeof createPgNotificationDeliveryStore>,
): Promise<NotificationDeliveryBatchEnqueueResult> {
  const pendingStore = createPgPendingActionStore(appPool);
  const idempotencyStore = createPgIdempotencyStore(appPool);
  const { registry, chainHooks } = createRegisteredM1Bus(
    {
      notification: Object.freeze({
        store: createPgNotificationStore(),
        delivery: Object.freeze({
          store: deliveryStore,
          capability: SOFTWARE_ONLY_NOTIFICATION_CAPABILITY,
        }),
        now: () => now,
      }),
    },
    pendingStore,
  );
  const idempotencyKey = randomUUID();
  const input = Object.freeze({
    order_ids: Object.freeze([orderId]),
    channel: "sms",
    template_code: "pickup_reminder_v1",
    max_cost_cents: 0,
    min_age_days: 180,
    unpaid_only: true,
    garment_statuses: Object.freeze(["racked"]),
  });
  const gated = await withPoolClient(appPool, (client) =>
    executeCommand(client, fixture.tenant, "notification.delivery_batch.enqueue", input, {
      registry,
      actor: fixture.actor,
      chainHooks,
      pendingStore,
      idempotencyStore,
      idempotencyKey,
      version: "0.1.0",
    }),
  );
  assert.equal(gated.ok, false, JSON.stringify(gated));
  const detail = !gated.ok && "detail" in gated.error ? gated.error.detail : undefined;
  if (detail?.kind !== "confirmation") assert.fail("notification enqueue must require R3");
  const created = await withPoolClient(appPool, (client) =>
    executeCommand(
      client,
      fixture.tenant,
      "notification.delivery_batch.enqueue",
      {},
      {
        registry,
        actor: fixture.actor,
        chainHooks,
        pendingStore,
        idempotencyStore,
        idempotencyKey,
        version: "0.1.0",
        confirmRef: detail.confirm_ref,
      },
    ),
  );
  assert.equal(created.ok, true, JSON.stringify(created));
  if (!created.ok) assert.fail("notification enqueue did not commit");
  return created.data.result as NotificationDeliveryBatchEnqueueResult;
}

export async function claimReadyAt(adminPool: PgPool, batchId: string): Promise<Date> {
  const result = await adminPool.query<Readonly<{ next_attempt_at: Date | string }>>(
    `SELECT next_attempt_at
       FROM notification_deliveries
      WHERE batch_id = $1::uuid
      ORDER BY created_at, id
      LIMIT 1`,
    [batchId],
  );
  const value = result.rows[0]?.next_attempt_at;
  assert.ok(value);
  const readyAt = value instanceof Date ? value : new Date(value);
  assert.equal(Number.isFinite(readyAt.getTime()), true);
  return new Date(readyAt.getTime() + 1);
}

export async function makeNotificationBatchReady(
  adminPool: PgPool,
  batchId: string,
): Promise<void> {
  const result = await adminPool.query(
    `UPDATE notification_deliveries
        SET next_attempt_at = statement_timestamp() - interval '1 millisecond',
            updated_at = GREATEST(updated_at, statement_timestamp())
      WHERE batch_id = $1::uuid AND status = 'retry_wait'`,
    [batchId],
  );
  assert.equal(result.rowCount, 1);
}

export async function seedExpiredNotificationClaim(
  adminPool: PgPool,
  batchId: string,
  attemptNo: number,
): Promise<string> {
  assert.ok(Number.isSafeInteger(attemptNo) && attemptNo >= 1 && attemptNo <= 5);
  const result = await adminPool.query<Readonly<{ id: string }>>(
    `UPDATE notification_deliveries
        SET status = 'sending', attempt_count = $2::integer,
            next_attempt_at = NULL,
            claimed_at = statement_timestamp() - interval '31 seconds',
            lease_until = statement_timestamp() - interval '1 second',
            lease_token = gen_random_uuid(), worker_id = 'fixture:expired',
            last_error_code = NULL, provider_outcome_pending = true,
            updated_at = GREATEST(updated_at, statement_timestamp())
      WHERE batch_id = $1::uuid
        AND status IN ('queued', 'retry_wait')
        AND attempt_count = $2::integer - 1
      RETURNING id::text`,
    [batchId, attemptNo],
  );
  const deliveryId = result.rows[0]?.id;
  assert.ok(deliveryId);
  return deliveryId;
}

export async function waitForOrderLock(adminPool: PgPool): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await adminPool.query<Readonly<{ waiting: number }>>(
      `SELECT COUNT(*)::integer AS waiting
         FROM pg_stat_activity
        WHERE usename = 'laundry_app' AND wait_event_type = 'Lock'
          AND query LIKE '%FROM orders%' AND query LIKE '%FOR SHARE%'`,
    );
    if ((result.rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("notification claim did not wait on the order privacy lock");
}
