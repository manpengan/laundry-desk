import type { SqlClient, TenantContext } from "../db/types.js";
import type {
  PendingActionTransactionContext,
  PendingRiskReservation,
  PendingRiskReservationRequest,
} from "./types.js";
import { PendingRiskCapacityExceededError } from "./types.js";

export async function lockPendingAuthorities(
  client: SqlClient,
  tenant: Pick<TenantContext, "orgId" | "storeId">,
): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended('customer-privacy-pending:' || $1::text, 0)
     )`,
    [tenant.orgId],
  );
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended('notification-risk:' || $1::text || ':' || $2::text, 0)
     )`,
    [tenant.orgId, tenant.storeId],
  );
}

type RiskMeasureRow = Readonly<{
  database_now_epoch: string | number;
  invalid_count: string | number;
  active_count: string | number;
  rolling_count: string | number;
  prior_units: string | number;
}>;

function safeInteger(value: string | number, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Persisted notification risk ${label} is invalid`);
  }
  return parsed;
}

export async function measureNotificationRisk(
  request: PendingRiskReservationRequest,
  transaction: PendingActionTransactionContext,
): Promise<PendingRiskReservation> {
  const result = await transaction.client.query<RiskMeasureRow>(
    `WITH clock AS (
       SELECT floor(extract(epoch FROM statement_timestamp()))::bigint AS now_epoch
     ), pending_reservations AS (
       SELECT pending.args_json
         FROM ai_pending_actions pending, clock
        WHERE pending.org_id = $1::uuid AND pending.store_id = $2::uuid
          AND pending.command = $3 AND pending.command_version = $4
          AND pending.created_at_epoch >= clock.now_epoch - $5::bigint
          AND pending.status = 'pending' AND pending.expires_at_epoch > clock.now_epoch
     ), active_pending AS (
       SELECT COUNT(*)::bigint AS count
         FROM ai_pending_actions pending, clock
        WHERE pending.org_id = $1::uuid AND pending.store_id = $2::uuid
          AND pending.command = $3 AND pending.command_version = $4
          AND pending.status = 'pending' AND pending.expires_at_epoch > clock.now_epoch
     ), rolling_pending AS (
       SELECT COUNT(*)::bigint AS count
         FROM ai_pending_actions pending, clock
        WHERE pending.org_id = $1::uuid AND pending.store_id = $2::uuid
          AND pending.command = $3 AND pending.command_version = $4
          AND pending.created_at_epoch >= clock.now_epoch - $5::bigint
     ), executed_batches AS (
       SELECT COALESCE(SUM(batch.recipient_count), 0)::bigint AS units
         FROM notification_delivery_batches batch, clock
        WHERE batch.org_id = $1::uuid AND batch.store_id = $2::uuid
          AND batch.created_at >= to_timestamp((clock.now_epoch - $5::bigint)::double precision)
     )
     SELECT clock.now_epoch AS database_now_epoch,
            active_pending.count AS active_count,
            rolling_pending.count AS rolling_count,
            COUNT(*) FILTER (
              WHERE pending_reservations.args_json IS NOT NULL
                AND CASE
                  WHEN jsonb_typeof(pending_reservations.args_json->'order_ids') = 'array'
                    THEN jsonb_array_length(pending_reservations.args_json->'order_ids')
                           NOT BETWEEN 1 AND 50
                  ELSE true
                END
            )::bigint AS invalid_count,
            COALESCE(SUM(
              CASE WHEN jsonb_typeof(pending_reservations.args_json->'order_ids') = 'array'
                   THEN jsonb_array_length(pending_reservations.args_json->'order_ids') ELSE 0 END
            ), 0)::bigint + executed_batches.units AS prior_units
       FROM clock CROSS JOIN active_pending CROSS JOIN rolling_pending CROSS JOIN executed_batches
       LEFT JOIN pending_reservations ON true
      GROUP BY clock.now_epoch, active_pending.count, rolling_pending.count,
               executed_batches.units`,
    [
      transaction.tenant.orgId,
      transaction.tenant.storeId,
      request.command,
      request.commandVersion,
      request.windowSeconds,
    ],
  );
  const row = result.rows[0];
  if (row === undefined || safeInteger(row.invalid_count, "shape count") !== 0) {
    throw new Error("Persisted notification risk reservation is invalid");
  }
  if (
    safeInteger(row.active_count, "active count") >= request.activePendingLimit ||
    safeInteger(row.rolling_count, "rolling count") >= request.rollingPendingLimit
  ) {
    throw new PendingRiskCapacityExceededError("Active notification pending limit reached");
  }
  const databaseNow = safeInteger(row.database_now_epoch, "clock");
  const priorUnits = safeInteger(row.prior_units, "units");
  const aggregateUnits = priorUnits + request.units;
  if (!Number.isSafeInteger(aggregateUnits)) {
    throw new Error("Notification risk reservation total is invalid");
  }
  return Object.freeze({
    kind: request.kind,
    units: request.units,
    prior_units: priorUnits,
    aggregate_units: aggregateUnits,
    threshold: request.threshold,
    window_started_at_epoch: databaseNow - request.windowSeconds,
  });
}
