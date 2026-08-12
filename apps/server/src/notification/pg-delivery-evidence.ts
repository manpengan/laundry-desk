import { createHash, randomUUID } from "node:crypto";

import type { PgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { withWorkerTenantTransaction } from "../db/worker-transaction.js";
import type {
  NotificationAttemptSettlement,
  NotificationReceiptInput,
  NotificationWorkerStore,
} from "./delivery-types.js";

const SAFE_ERROR = /^[A-Z][A-Z0-9_]{0,63}$/u;
const SAFE_PROVIDER = /^[a-z][a-z0-9_]{0,31}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const RECEIPT_TIMEOUT_MS = 72 * 60 * 60 * 1_000;
const RETRY_DELAYS_MS = Object.freeze([60_000, 300_000, 1_800_000, 7_200_000]);

type SettlementPointer = Readonly<{ batch_id: string; order_id: string }>;
type SettlementRow = Readonly<{
  id: string;
  status: string;
  batch_id: string;
  attempt_count: number;
  lease_token: string | null;
  reserved_cost_cents: number;
}>;
type ReceiptRow = Readonly<{
  status: string;
  provider_code: string;
  accepted_at: Date | string | null;
}>;
type PendingReceiptRow = Readonly<{
  status: "delivered" | "failed";
  observed_at: Date | string;
  recorded_at: Date | string;
}>;

function validDate(value: Date, label: string): void {
  if (!Number.isFinite(value.getTime())) throw new TypeError(`Invalid notification ${label}`);
}

function validateSettlement(settlement: NotificationAttemptSettlement): void {
  validDate(settlement.startedAt, "attempt start");
  validDate(settlement.completedAt, "attempt completion");
  if (settlement.completedAt < settlement.startedAt) {
    throw new TypeError("Notification attempt completed before it started");
  }
  if (!Number.isSafeInteger(settlement.attemptNo) || settlement.attemptNo < 1) {
    throw new TypeError("Invalid notification attempt number");
  }
  if (
    !Number.isSafeInteger(settlement.costCents) ||
    settlement.costCents < 0 ||
    settlement.costCents > 100_000
  ) {
    throw new TypeError("Invalid notification attempt cost");
  }
  const accepted = settlement.outcome === "accepted";
  const validShape = accepted
    ? settlement.errorCode === null &&
      settlement.providerRefSha256 !== null &&
      SHA256.test(settlement.providerRefSha256)
    : settlement.errorCode !== null &&
      SAFE_ERROR.test(settlement.errorCode) &&
      settlement.providerRefSha256 === null &&
      settlement.costCents === 0;
  if (!validShape) throw new TypeError("Invalid notification attempt result");
}

function validateReceipt(receipt: NotificationReceiptInput): void {
  validDate(receipt.observedAt, "receipt observation");
  validDate(receipt.recordedAt, "receipt recording");
  if (receipt.recordedAt < receipt.observedAt) {
    throw new TypeError("Notification receipt recorded before observation");
  }
  if (!SAFE_PROVIDER.test(receipt.providerCode)) {
    throw new TypeError("Invalid notification receipt provider");
  }
  if (receipt.receiptId.length < 1 || receipt.receiptId.length > 512) {
    throw new TypeError("Invalid notification receipt id");
  }
}

async function lockBatch(client: SqlClient, batchId: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text, 44))", [batchId]);
}

async function settlementPointer(
  client: SqlClient,
  tenant: TenantContext,
  deliveryId: string,
): Promise<SettlementPointer | null> {
  const result = await client.query<SettlementPointer>(
    `SELECT batch_id, order_id
       FROM notification_deliveries
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
    [tenant.orgId, tenant.storeId, deliveryId],
  );
  return result.rows[0] ?? null;
}

async function lockSettlementOrder(
  client: SqlClient,
  tenant: TenantContext,
  orderId: string,
): Promise<boolean> {
  const result = await client.query<Readonly<{ customer_pii_purged_at: Date | string | null }>>(
    `SELECT customer_pii_purged_at
       FROM orders
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid
      FOR SHARE`,
    [tenant.orgId, tenant.storeId, orderId],
  );
  return result.rows[0]?.customer_pii_purged_at === null;
}

async function lockSettlement(
  client: SqlClient,
  tenant: TenantContext,
  deliveryId: string,
): Promise<SettlementRow | null> {
  const result = await client.query<SettlementRow>(
    `SELECT delivery.id, delivery.status, delivery.batch_id,
            delivery.attempt_count, delivery.lease_token,
            delivery.reserved_cost_cents
       FROM notification_deliveries delivery
       JOIN notification_delivery_batches batch
         ON batch.org_id = delivery.org_id AND batch.store_id = delivery.store_id
        AND batch.id = delivery.batch_id
      WHERE delivery.org_id = $1::uuid AND delivery.store_id = $2::uuid
        AND delivery.id = $3::uuid
      FOR UPDATE OF delivery`,
    [tenant.orgId, tenant.storeId, deliveryId],
  );
  return result.rows[0] ?? null;
}

function retryDelayMs(attemptNo: number): number {
  return RETRY_DELAYS_MS[attemptNo - 1] ?? RETRY_DELAYS_MS.at(-1) ?? 7_200_000;
}

async function insertAttempt(
  client: SqlClient,
  tenant: TenantContext,
  settlement: NotificationAttemptSettlement,
): Promise<void> {
  await client.query(
    `INSERT INTO notification_delivery_attempts (
       id, org_id, store_id, delivery_id, attempt_no, outcome, error_code,
       provider_ref_sha256, cost_cents, started_at, completed_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::integer, $6, $7,
       $8, $9::integer, $10::timestamptz, $11::timestamptz
     )`,
    [
      randomUUID(),
      tenant.orgId,
      tenant.storeId,
      settlement.deliveryId,
      settlement.attemptNo,
      settlement.outcome,
      settlement.errorCode,
      settlement.providerRefSha256,
      settlement.costCents,
      settlement.startedAt.toISOString(),
      settlement.completedAt.toISOString(),
    ],
  );
}

function settlementState(
  row: SettlementRow,
  settlement: NotificationAttemptSettlement,
): Readonly<{
  status: "accepted" | "retry_wait" | "manual_required";
  errorCode: string | null;
  costAccepted: boolean;
}> {
  const costInvalid = settlement.costCents > row.reserved_cost_cents;
  const accepted = settlement.outcome === "accepted" && !costInvalid;
  const retry =
    !accepted &&
    !costInvalid &&
    settlement.outcome !== "permanent_failure" &&
    settlement.attemptNo < 5;
  return Object.freeze({
    status: accepted ? "accepted" : retry ? "retry_wait" : "manual_required",
    errorCode: costInvalid
      ? "COST_LIMIT_EXCEEDED"
      : accepted
        ? null
        : (settlement.errorCode ?? "PROVIDER_RESULT_INVALID"),
    costAccepted: settlement.outcome === "accepted",
  });
}

async function updateSettlement(
  client: SqlClient,
  settlement: NotificationAttemptSettlement,
  state: ReturnType<typeof settlementState>,
): Promise<void> {
  const retryDelay = retryDelayMs(settlement.attemptNo);
  await client.query(
    `UPDATE notification_deliveries
        SET status = $2, next_attempt_at = CASE WHEN $2 = 'retry_wait'
              THEN statement_timestamp() + $3::bigint * interval '1 millisecond' ELSE NULL END,
            claimed_at = NULL, lease_until = NULL, lease_token = NULL, worker_id = NULL,
            last_error_code = $4,
            provider_ref_sha256 = CASE WHEN $5::boolean THEN $6 ELSE NULL END,
            cost_cents = CASE WHEN $5::boolean THEN $7::integer ELSE cost_cents END,
            reserved_cost_cents = CASE
              WHEN $8 = 'uncertain' THEN reserved_cost_cents ELSE 0
            END,
            provider_outcome_pending = false,
            accepted_at = CASE WHEN $5::boolean THEN statement_timestamp() ELSE NULL END,
            updated_at = GREATEST(updated_at, statement_timestamp())
      WHERE id = $1::uuid`,
    [
      settlement.deliveryId,
      state.status,
      retryDelay,
      state.errorCode,
      state.costAccepted,
      settlement.providerRefSha256,
      settlement.costCents,
      settlement.outcome,
    ],
  );
}

async function applyPendingReceipt(client: SqlClient, deliveryId: string): Promise<boolean> {
  const receiptResult = await client.query<PendingReceiptRow>(
    `SELECT status, observed_at, recorded_at
       FROM notification_delivery_receipts
      WHERE delivery_id = $1::uuid
      ORDER BY CASE status WHEN 'delivered' THEN 0 ELSE 1 END,
               observed_at, id
      LIMIT 1`,
    [deliveryId],
  );
  const receipt = receiptResult.rows[0];
  if (receipt === undefined) return false;
  const result = await client.query(
    `UPDATE notification_deliveries
        SET status = CASE WHEN $2 = 'delivered' THEN 'delivered' ELSE 'manual_required' END,
            recipient_hmac = NULL, message_sha256 = NULL,
            delivered_at = CASE
              WHEN $2 = 'delivered' THEN GREATEST($3::timestamptz, accepted_at)
              ELSE NULL
            END,
            last_error_code = CASE
              WHEN $2 = 'failed' THEN 'PROVIDER_DELIVERY_FAILED' ELSE NULL
            END,
            updated_at = GREATEST(updated_at, $4::timestamptz)
      WHERE id = $1::uuid AND status = 'accepted'`,
    [deliveryId, receipt.status, receipt.observed_at, receipt.recorded_at],
  );
  return result.rowCount === 1;
}

async function settleInTransaction(
  client: SqlClient,
  tenant: TenantContext,
  settlement: NotificationAttemptSettlement,
): Promise<"accepted" | "retry_wait" | "manual_required" | "stale_lease"> {
  const pointer = await settlementPointer(client, tenant, settlement.deliveryId);
  if (pointer === null) return "stale_lease";
  await lockBatch(client, pointer.batch_id);
  if (!(await lockSettlementOrder(client, tenant, pointer.order_id))) return "stale_lease";
  const row = await lockSettlement(client, tenant, settlement.deliveryId);
  if (
    row === null ||
    row.status !== "sending" ||
    row.batch_id !== pointer.batch_id ||
    row.lease_token !== settlement.leaseToken ||
    row.attempt_count !== settlement.attemptNo
  ) {
    return "stale_lease";
  }
  const state = settlementState(row, settlement);
  await insertAttempt(client, tenant, settlement);
  await updateSettlement(client, settlement, state);
  if (state.status === "accepted" && (await applyPendingReceipt(client, settlement.deliveryId))) {
    return "accepted";
  }
  return state.status;
}

async function expireInTransaction(
  client: SqlClient,
  tenant: TenantContext,
  limit: number,
): Promise<number> {
  const result = await client.query(
    `WITH expired AS (
       SELECT id
         FROM notification_deliveries
        WHERE org_id = $1::uuid AND store_id = $2::uuid
          AND status = 'accepted'
          AND accepted_at <= statement_timestamp() - $3::bigint * interval '1 millisecond'
        ORDER BY accepted_at, id
        FOR UPDATE SKIP LOCKED
        LIMIT $4::integer
     )
     UPDATE notification_deliveries delivery
        SET status = 'manual_required', recipient_hmac = NULL, message_sha256 = NULL,
            last_error_code = 'RECEIPT_TIMEOUT',
            updated_at = GREATEST(delivery.updated_at, statement_timestamp())
       FROM expired
      WHERE delivery.id = expired.id`,
    [tenant.orgId, tenant.storeId, RECEIPT_TIMEOUT_MS, limit],
  );
  return result.rowCount ?? 0;
}

async function applyReceiptInTransaction(
  client: SqlClient,
  tenant: TenantContext,
  receipt: NotificationReceiptInput,
): Promise<"applied" | "pending" | "duplicate" | "ignored" | "not_found"> {
  const rowResult = await client.query<ReceiptRow>(
    `SELECT delivery.status, batch.provider_code, delivery.accepted_at
       FROM notification_deliveries delivery
       JOIN notification_delivery_batches batch
         ON batch.org_id = delivery.org_id AND batch.store_id = delivery.store_id
        AND batch.id = delivery.batch_id
      WHERE delivery.org_id = $1::uuid AND delivery.store_id = $2::uuid
        AND delivery.id = $3::uuid
      FOR UPDATE OF delivery`,
    [tenant.orgId, tenant.storeId, receipt.deliveryId],
  );
  const row = rowResult.rows[0];
  if (row === undefined) return "not_found";
  if (row.provider_code !== receipt.providerCode) return "ignored";
  const receiptHash = createHash("sha256").update(receipt.receiptId, "utf8").digest("hex");
  const inserted = await client.query(
    `INSERT INTO notification_delivery_receipts (
       id, org_id, store_id, delivery_id, provider_code, receipt_sha256,
       status, observed_at, recorded_at
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
       $8::timestamptz, $9::timestamptz
     ) ON CONFLICT (org_id, store_id, provider_code, receipt_sha256) DO NOTHING`,
    [
      randomUUID(),
      tenant.orgId,
      tenant.storeId,
      receipt.deliveryId,
      receipt.providerCode,
      receiptHash,
      receipt.status,
      receipt.observedAt.toISOString(),
      receipt.recordedAt.toISOString(),
    ],
  );
  if (inserted.rowCount !== 1) return "duplicate";
  if (row.status !== "accepted" || row.accepted_at === null) {
    return ["queued", "sending", "retry_wait"].includes(row.status) ? "pending" : "ignored";
  }
  return (await applyPendingReceipt(client, receipt.deliveryId)) ? "applied" : "ignored";
}

export function createPgNotificationEvidenceStore(pool: PgPool) {
  const run = <T>(tenant: TenantContext, operation: (client: SqlClient) => Promise<T>) =>
    withPoolClient(pool, (client) => withWorkerTenantTransaction(client, tenant, operation));
  return Object.freeze({
    settleAttempt: (tenant: TenantContext, settlement: NotificationAttemptSettlement) => {
      validateSettlement(settlement);
      return run(tenant, (client) => settleInTransaction(client, tenant, settlement));
    },
    expireAccepted: (tenant: TenantContext, now: Date, limit: number) => {
      validDate(now, "receipt timeout time");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new TypeError("Invalid notification receipt timeout batch");
      }
      return run(tenant, (client) => expireInTransaction(client, tenant, limit));
    },
    applyReceipt: (tenant: TenantContext, receipt: NotificationReceiptInput) => {
      validateReceipt(receipt);
      return run(tenant, (client) => applyReceiptInTransaction(client, tenant, receipt));
    },
  } satisfies Pick<NotificationWorkerStore, "settleAttempt" | "expireAccepted" | "applyReceipt">);
}
