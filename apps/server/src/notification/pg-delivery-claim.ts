import { createHash, randomUUID } from "node:crypto";

import type { PickupReminderCandidate } from "@laundry/contracts";
import { groupPickupReminders, renderPickupReminder } from "@laundry/domain";

import type { PgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withWorkerTenantTransaction } from "../db/worker-transaction.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import type { NotificationDeliveryClaim } from "./delivery-types.js";
import {
  NOTIFICATION_DELIVERY_LEASE_MS,
  expireExhaustedNotificationLeases,
  lockNotificationBatch,
  lockNotificationOrder,
  renewNotificationDeliveryLease,
} from "./pg-delivery-lease.js";
import { createPgNotificationStore } from "./pg-store.js";

const WORKER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const reminderStore = createPgNotificationStore();

type CandidatePointer = Readonly<{ id: string; batch_id: string; order_id: string }>;
type ClaimRow = Readonly<{
  id: string;
  batch_id: string;
  order_id: string;
  customer_id: string;
  recipient_hmac: string;
  recipient_matches: boolean;
  message_sha256: string;
  status: "queued" | "retry_wait" | "sending";
  attempt_count: number;
  claimed_at: Date | string | null;
  provider_code: string;
  assurance: "software_only" | "external";
  template_id: string;
  template_code: "pickup_reminder_v1";
  template_version: number;
  template_channel: "sms";
  template_body: string;
  min_age_days: 30 | 90 | 180;
  unpaid_only: boolean;
  garment_statuses: readonly string[];
  recipient_count: number;
  estimated_cost_cents: number;
  max_cost_cents: number;
  spent_cost_cents: string | number;
  allocated_cost_cents: string | number;
  reserved_cost_cents: number;
}>;

function assertWorkerInput(workerId: string, now: Date): void {
  if (!WORKER_ID.test(workerId)) throw new TypeError("Invalid notification worker id");
  if (!Number.isFinite(now.getTime())) throw new TypeError("Invalid notification claim time");
}

function safeInteger(value: string | number, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError(`Invalid notification ${label}`);
  }
  return parsed;
}

function garmentStatuses(values: readonly string[]): readonly ("ready" | "racked")[] {
  const canonical = (["ready", "racked"] as const).filter((status) => values.includes(status));
  if (canonical.length !== values.length || canonical.length === 0) {
    throw new TypeError("Invalid notification batch garment statuses");
  }
  return Object.freeze(canonical);
}

async function candidatePointer(
  client: SqlClient,
  tenant: TenantContext,
): Promise<CandidatePointer | null> {
  const result = await client.query<CandidatePointer>(
    `SELECT id, batch_id, order_id
       FROM notification_deliveries
      WHERE org_id = $1::uuid AND store_id = $2::uuid
        AND attempt_count < 5
        AND (
          (status IN ('queued', 'retry_wait') AND next_attempt_at <= statement_timestamp())
          OR (status = 'sending' AND lease_until <= statement_timestamp())
        )
      ORDER BY COALESCE(next_attempt_at, lease_until), created_at, id
      LIMIT 1`,
    [tenant.orgId, tenant.storeId],
  );
  return result.rows[0] ?? null;
}

async function lockDelivery(
  client: SqlClient,
  tenant: TenantContext,
  pointer: CandidatePointer,
): Promise<ClaimRow | null> {
  const result = await client.query<ClaimRow>(
    `SELECT delivery.id, delivery.batch_id, delivery.order_id, delivery.customer_id,
            delivery.recipient_hmac, delivery.message_sha256, delivery.attempt_count,
            delivery.status, delivery.claimed_at, delivery.reserved_cost_cents,
            notification_recipient_matches(
              delivery.org_id, delivery.store_id, delivery.order_id,
              delivery.customer_id, delivery.recipient_hmac
            ) AS recipient_matches,
            batch.provider_code, batch.assurance, batch.template_id,
            batch.template_code, batch.template_version,
            template.channel AS template_channel, template.body AS template_body,
            batch.min_age_days, batch.unpaid_only, batch.garment_statuses,
            batch.recipient_count, batch.estimated_cost_cents, batch.max_cost_cents,
            (SELECT COALESCE(SUM(spent.cost_cents), 0)
               FROM notification_deliveries spent
              WHERE spent.org_id = delivery.org_id
                AND spent.store_id = delivery.store_id
                AND spent.batch_id = delivery.batch_id) AS spent_cost_cents,
            (SELECT COALESCE(SUM(spent.cost_cents + spent.reserved_cost_cents), 0)
               FROM notification_deliveries spent
              WHERE spent.org_id = delivery.org_id
                AND spent.store_id = delivery.store_id
                AND spent.batch_id = delivery.batch_id) AS allocated_cost_cents
       FROM notification_deliveries delivery
       JOIN notification_delivery_batches batch
         ON batch.org_id = delivery.org_id AND batch.store_id = delivery.store_id
        AND batch.id = delivery.batch_id
       JOIN notification_templates template
         ON template.org_id = batch.org_id AND template.id = batch.template_id
       JOIN orders
         ON orders.org_id = delivery.org_id AND orders.store_id = delivery.store_id
        AND orders.id = delivery.order_id
      WHERE delivery.org_id = $1::uuid AND delivery.store_id = $2::uuid
        AND delivery.id = $3::uuid AND delivery.order_id = $4::uuid
        AND delivery.attempt_count < 5
        AND (
          (delivery.status IN ('queued', 'retry_wait')
            AND delivery.next_attempt_at <= statement_timestamp())
          OR (delivery.status = 'sending' AND delivery.lease_until <= statement_timestamp())
        )
      FOR UPDATE OF delivery SKIP LOCKED`,
    [tenant.orgId, tenant.storeId, pointer.id, pointer.order_id],
  );
  return result.rows[0] ?? null;
}

async function recordExpiredAttempt(client: SqlClient, row: ClaimRow): Promise<void> {
  if (row.status !== "sending" || row.claimed_at === null) return;
  await client.query(
    `INSERT INTO notification_delivery_attempts (
       id, org_id, store_id, delivery_id, attempt_no, outcome, error_code,
       provider_ref_sha256, cost_cents, started_at, completed_at
     )
     SELECT gen_random_uuid(), org_id, store_id, id, attempt_count,
            'uncertain', 'PROVIDER_LEASE_EXPIRED', NULL, 0,
            claimed_at, statement_timestamp()
       FROM notification_deliveries
      WHERE id = $1::uuid
     ON CONFLICT (org_id, store_id, delivery_id, attempt_no) DO NOTHING`,
    [row.id],
  );
}

async function currentCandidate(
  client: SqlClient,
  tenant: TenantContext,
  row: ClaimRow,
  now: Date,
) {
  const candidates = await reminderStore.listPickupReminders({
    client,
    tenant,
    filters: Object.freeze({
      minAgeDays: row.min_age_days,
      unpaidOnly: row.unpaid_only,
      garmentStatuses: garmentStatuses(row.garment_statuses),
      limit: 1,
    }),
    orderIds: [row.order_id],
    now,
  });
  return candidates[0];
}

function targetMatches(row: ClaimRow, candidate: PickupReminderCandidate | undefined): boolean {
  if (candidate?.customer_id !== row.customer_id) return false;
  const group = groupPickupReminders([candidate], "order")[0];
  if (group === undefined) return false;
  const digest = createHash("sha256")
    .update(renderPickupReminder(row.template_body, group), "utf8")
    .digest("hex");
  return row.recipient_matches && row.message_sha256 === digest;
}

async function markSnapshotChanged(client: SqlClient, row: ClaimRow): Promise<void> {
  await client.query(
    `UPDATE notification_deliveries
        SET status = 'manual_required', recipient_hmac = NULL, message_sha256 = NULL,
            next_attempt_at = NULL, claimed_at = NULL, lease_until = NULL,
            lease_token = NULL, worker_id = NULL,
            provider_outcome_pending = false,
            last_error_code = 'TARGET_SNAPSHOT_CHANGED',
            updated_at = GREATEST(updated_at, statement_timestamp())
      WHERE id = $1::uuid`,
    [row.id],
  );
}

function reservationCost(row: ClaimRow): number {
  if (row.reserved_cost_cents > 0) return row.reserved_cost_cents;
  if (row.estimated_cost_cents % row.recipient_count !== 0) {
    throw new TypeError("Invalid notification batch unit cost");
  }
  return safeInteger(row.estimated_cost_cents / row.recipient_count, "reservation cost");
}

function canReserve(row: ClaimRow, reservedCost: number): boolean {
  const allocated = safeInteger(row.allocated_cost_cents, "allocated cost");
  const increment = row.reserved_cost_cents === 0 ? reservedCost : 0;
  return allocated + increment <= row.max_cost_cents;
}

async function markCostExceeded(client: SqlClient, row: ClaimRow): Promise<void> {
  await client.query(
    `UPDATE notification_deliveries
        SET status = 'manual_required', recipient_hmac = NULL, message_sha256 = NULL,
            next_attempt_at = NULL, claimed_at = NULL, lease_until = NULL,
            lease_token = NULL, worker_id = NULL, reserved_cost_cents = 0,
            provider_outcome_pending = false,
            last_error_code = 'COST_LIMIT_EXCEEDED',
            updated_at = GREATEST(updated_at, statement_timestamp())
      WHERE id = $1::uuid`,
    [row.id],
  );
}

async function claimLocked(
  client: SqlClient,
  row: ClaimRow,
  candidate: PickupReminderCandidate & Readonly<{ customer_id: string }>,
  workerId: string,
  reservedCost: number,
): Promise<NotificationDeliveryClaim> {
  const leaseToken = randomUUID();
  await client.query(
    `UPDATE notification_deliveries
        SET status = 'sending', attempt_count = attempt_count + 1,
            next_attempt_at = NULL, claimed_at = statement_timestamp(),
            lease_until = statement_timestamp() + $2::bigint * interval '1 millisecond',
            lease_token = $3::uuid,
            worker_id = $4, last_error_code = NULL, reserved_cost_cents = $5::integer,
            provider_outcome_pending = true,
            updated_at = GREATEST(updated_at, statement_timestamp())
      WHERE id = $1::uuid`,
    [row.id, NOTIFICATION_DELIVERY_LEASE_MS, leaseToken, workerId, reservedCost],
  );
  return Object.freeze({
    deliveryId: row.id,
    batchId: row.batch_id,
    leaseToken,
    attemptNo: row.attempt_count + 1,
    providerCode: row.provider_code,
    assurance: row.assurance,
    template: Object.freeze({
      id: row.template_id,
      code: row.template_code,
      version: row.template_version,
      channel: row.template_channel,
      body: row.template_body,
    }),
    candidate,
    expectedMessageSha256: row.message_sha256,
    batchEstimatedCostCents: row.estimated_cost_cents,
    batchRecipientCount: row.recipient_count,
    maxCostCents: row.max_cost_cents,
    spentCostCents: safeInteger(row.spent_cost_cents, "spent cost"),
    reservedCostCents: reservedCost,
  });
}

async function claimInTransaction(
  client: SqlClient,
  tenant: TenantContext,
  workerId: string,
): Promise<NotificationDeliveryClaim | null> {
  const clock = await client.query<Readonly<{ database_now: Date | string }>>(
    "SELECT statement_timestamp() AS database_now",
  );
  const databaseNowValue = clock.rows[0]?.database_now;
  if (databaseNowValue === undefined) throw new Error("Notification database clock unavailable");
  const databaseNow =
    databaseNowValue instanceof Date ? databaseNowValue : new Date(databaseNowValue);
  if (!Number.isFinite(databaseNow.getTime()))
    throw new Error("Notification database clock invalid");
  const pointer = await candidatePointer(client, tenant);
  if (pointer === null) return null;
  await lockNotificationBatch(client, pointer.batch_id);
  if (!(await lockNotificationOrder(client, tenant, pointer.order_id))) return null;
  const row = await lockDelivery(client, tenant, pointer);
  if (row === null || row.batch_id !== pointer.batch_id) return null;
  await recordExpiredAttempt(client, row);
  const reservedCost = reservationCost(row);
  if (!canReserve(row, reservedCost)) {
    await markCostExceeded(client, row);
    return null;
  }
  const candidate = await currentCandidate(client, tenant, row, databaseNow);
  if (
    !targetMatches(row, candidate) ||
    candidate?.customer_id === null ||
    candidate === undefined
  ) {
    await markSnapshotChanged(client, row);
    return null;
  }
  return claimLocked(
    client,
    row,
    candidate as PickupReminderCandidate & Readonly<{ customer_id: string }>,
    workerId,
    reservedCost,
  );
}

export function createPgNotificationClaimStore(pool: PgPool) {
  return Object.freeze({
    claimNext: async (tenant: TenantContext, workerId: string, now: Date) => {
      assertWorkerInput(workerId, now);
      await expireExhaustedNotificationLeases(pool, tenant);
      return withPoolClient(pool, (client) =>
        withWorkerTenantTransaction(client, tenant, (tx) =>
          claimInTransaction(tx, tenant, workerId),
        ),
      );
    },
    renewLease: (tenant: TenantContext, deliveryId: string, leaseToken: string, now: Date) =>
      renewNotificationDeliveryLease(pool, tenant, deliveryId, leaseToken, now),
  });
}
