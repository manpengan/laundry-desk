import type { PgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withWorkerTenantTransaction } from "../db/worker-transaction.js";
import type { SqlClient, TenantContext } from "../db/types.js";

export const NOTIFICATION_DELIVERY_LEASE_MS = 30_000;

const EXHAUSTED_SWEEP_LIMIT = 50;

type ExhaustedPointer = Readonly<{ id: string; batch_id: string; order_id: string }>;
type ExhaustedRow = Readonly<{
  id: string;
  org_id: string;
  store_id: string;
  attempt_count: number;
  claimed_at: Date | string;
}>;

export async function lockNotificationBatch(client: SqlClient, batchId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 44))", [batchId]);
}

export async function lockNotificationOrder(
  client: SqlClient,
  tenant: TenantContext,
  orderId: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT id
       FROM orders
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      FOR SHARE`,
    [tenant.orgId, tenant.storeId, orderId],
  );
  return result.rowCount === 1;
}

async function exhaustedPointer(
  client: SqlClient,
  tenant: TenantContext,
): Promise<ExhaustedPointer | null> {
  const result = await client.query<ExhaustedPointer>(
    `SELECT id, batch_id, order_id
       FROM notification_deliveries
      WHERE org_id = $1::uuid AND store_id = $2::uuid
        AND status = 'sending' AND attempt_count >= 5
        AND lease_until <= statement_timestamp()
      ORDER BY lease_until, created_at, id
      LIMIT 1`,
    [tenant.orgId, tenant.storeId],
  );
  return result.rows[0] ?? null;
}

async function lockExhaustedDelivery(
  client: SqlClient,
  tenant: TenantContext,
  pointer: ExhaustedPointer,
): Promise<ExhaustedRow | null> {
  const result = await client.query<ExhaustedRow>(
    `SELECT id, org_id, store_id, attempt_count, claimed_at
       FROM notification_deliveries
      WHERE org_id = $1::uuid AND store_id = $2::uuid
        AND id = $3::uuid AND batch_id = $4::uuid AND order_id = $5::uuid
        AND status = 'sending' AND attempt_count >= 5
        AND lease_until <= statement_timestamp()
      FOR UPDATE SKIP LOCKED`,
    [tenant.orgId, tenant.storeId, pointer.id, pointer.batch_id, pointer.order_id],
  );
  return result.rows[0] ?? null;
}

async function expireOneExhaustedLease(client: SqlClient, tenant: TenantContext): Promise<boolean> {
  const pointer = await exhaustedPointer(client, tenant);
  if (pointer === null) return false;
  await lockNotificationBatch(client, pointer.batch_id);
  if (!(await lockNotificationOrder(client, tenant, pointer.order_id))) return false;
  const row = await lockExhaustedDelivery(client, tenant, pointer);
  if (row === null) return false;

  await client.query(
    `INSERT INTO notification_delivery_attempts (
       id, org_id, store_id, delivery_id, attempt_no, outcome, error_code,
       provider_ref_sha256, cost_cents, started_at, completed_at
     ) VALUES (
       gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::integer,
       'uncertain', 'PROVIDER_LEASE_EXPIRED', NULL, 0,
       $5::timestamptz, statement_timestamp()
     ) ON CONFLICT (org_id, store_id, delivery_id, attempt_no) DO NOTHING`,
    [row.org_id, row.store_id, row.id, row.attempt_count, row.claimed_at],
  );
  await client.query(
    `UPDATE notification_deliveries
        SET status = 'manual_required', recipient_hmac = NULL, message_sha256 = NULL,
            next_attempt_at = NULL, claimed_at = NULL, lease_until = NULL,
            lease_token = NULL, worker_id = NULL,
            provider_outcome_pending = false,
            last_error_code = 'PROVIDER_RETRY_EXHAUSTED',
            updated_at = GREATEST(updated_at, statement_timestamp())
      WHERE id = $1::uuid`,
    [row.id],
  );
  return true;
}

/**
 * Finalizes abandoned fifth attempts in independent transactions. Each transaction acquires the
 * shared batch -> order -> delivery lock order, and releases it before selecting another row.
 */
export async function expireExhaustedNotificationLeases(
  pool: PgPool,
  tenant: TenantContext,
): Promise<void> {
  for (let index = 0; index < EXHAUSTED_SWEEP_LIMIT; index += 1) {
    const expired = await withPoolClient(pool, (client) =>
      withWorkerTenantTransaction(client, tenant, (tx) => expireOneExhaustedLease(tx, tenant)),
    );
    if (!expired) return;
  }
}

function assertLeaseInput(deliveryId: string, leaseToken: string, now: Date): void {
  if (deliveryId.length === 0 || leaseToken.length === 0) {
    throw new TypeError("Invalid notification lease identity");
  }
  if (!Number.isFinite(now.getTime())) throw new TypeError("Invalid notification lease time");
}

async function renewLeaseInTransaction(
  client: SqlClient,
  tenant: TenantContext,
  deliveryId: string,
  leaseToken: string,
): Promise<boolean> {
  const pointer = await client.query<Readonly<{ order_id: string }>>(
    `SELECT order_id
       FROM notification_deliveries
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
    [tenant.orgId, tenant.storeId, deliveryId],
  );
  const orderId = pointer.rows[0]?.order_id;
  if (orderId === undefined || !(await lockNotificationOrder(client, tenant, orderId))) {
    return false;
  }
  const result = await client.query(
    `UPDATE notification_deliveries
        SET lease_until = statement_timestamp() + $4::bigint * interval '1 millisecond',
            updated_at = GREATEST(updated_at, statement_timestamp())
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
        AND status = 'sending' AND lease_token = $5::uuid
        AND lease_until > statement_timestamp()
        AND lease_until < statement_timestamp() + $4::bigint * interval '1 millisecond'`,
    [tenant.orgId, tenant.storeId, deliveryId, NOTIFICATION_DELIVERY_LEASE_MS, leaseToken],
  );
  return result.rowCount === 1;
}

export function renewNotificationDeliveryLease(
  pool: PgPool,
  tenant: TenantContext,
  deliveryId: string,
  leaseToken: string,
  now: Date,
): Promise<boolean> {
  assertLeaseInput(deliveryId, leaseToken, now);
  return withPoolClient(pool, (client) =>
    withWorkerTenantTransaction(client, tenant, (tx) =>
      renewLeaseInTransaction(tx, tenant, deliveryId, leaseToken),
    ),
  );
}
