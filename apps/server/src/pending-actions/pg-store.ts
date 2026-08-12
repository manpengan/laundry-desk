/** PostgreSQL-backed WYSIWYS confirmation authority. */

import type { PgPool } from "../db/pg-pool.js";
import { withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { lockPendingAuthorities, measureNotificationRisk } from "./pg-risk-reservation.js";
import {
  actionFromRow,
  pendingEpoch,
  SELECT_COLUMNS,
  type PendingActionRow,
  type PendingActionWithClockRow,
} from "./pg-row.js";
import { createPendingActionSnapshot, freezePendingAction } from "./store.js";
import type {
  PendingAction,
  PendingActionStore,
  PendingActionTransactionContext,
} from "./types.js";

/**
 * Invalid cards remain available for operational diagnosis for 30 days.
 * Recent durable idempotency state keeps a consumed card replayable for the
 * same 30-day window; older frozen args are eligible for bounded cleanup.
 */
export const PENDING_ACTION_RETENTION_SECONDS = 30 * 24 * 60 * 60;
export const PENDING_ACTION_CLEANUP_BATCH_SIZE = 100;

function assertScope(
  action: Pick<PendingAction, "orgId" | "storeId">,
  tenant: TenantContext,
): void {
  if (action.orgId !== tenant.orgId || action.storeId !== tenant.storeId) {
    throw new Error("Pending action scope does not match authenticated tenant");
  }
}

async function selectAction(
  client: SqlClient,
  tenant: TenantContext,
  nonce: string,
  forUpdate: boolean,
): Promise<PendingAction | null> {
  const result = await client.query<PendingActionWithClockRow>(
    `SELECT ${SELECT_COLUMNS},
            floor(extract(epoch FROM statement_timestamp()))::bigint AS database_now_epoch
     FROM ai_pending_actions
     WHERE nonce = $1::uuid AND org_id = $2::uuid AND store_id = $3::uuid
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [nonce, tenant.orgId, tenant.storeId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const action = actionFromRow(row);
  return action.status === "pending" &&
    pendingEpoch(row.database_now_epoch, "database_now_epoch") >= action.expiresAt
    ? freezePendingAction({ ...action, status: "expired" })
    : action;
}

async function selectActionByIdempotency(
  client: SqlClient,
  tenant: TenantContext,
  command: string,
  idempotencyKey: string,
): Promise<PendingAction | null> {
  const result = await client.query<PendingActionWithClockRow>(
    `SELECT ${SELECT_COLUMNS},
            floor(extract(epoch FROM statement_timestamp()))::bigint AS database_now_epoch
       FROM ai_pending_actions
      WHERE org_id = $1::uuid AND store_id = $2::uuid
        AND command = $3 AND idempotency_key = $4::uuid
      ORDER BY created_at_epoch, nonce
      LIMIT 1`,
    [tenant.orgId, tenant.storeId, command, idempotencyKey],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const action = actionFromRow(row);
  return action.status === "pending" &&
    pendingEpoch(row.database_now_epoch, "database_now_epoch") >= action.expiresAt
    ? freezePendingAction({ ...action, status: "expired" })
    : action;
}

function requireTransaction(
  context: PendingActionTransactionContext | undefined,
): PendingActionTransactionContext {
  if (context === undefined) {
    throw new Error("PostgreSQL pending action mutation requires the command transaction");
  }
  return context;
}

async function insertAction(client: SqlClient, action: PendingAction): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO ai_pending_actions (
       nonce, org_id, store_id, command, command_version, args_json,
       authority_json, authority_present, args_hash, entity_versions_json,
       creator_staff_id, idempotency_key, created_at_epoch, expires_at_epoch,
       status, effective_risk, policy_outcome, requires_other_approver,
       consumed_by_staff_id, consumed_at_epoch, privacy_subject_customer_id
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb,
       $7::jsonb, $8, $9, $10::jsonb,
       $11::uuid, $12::uuid, $13::bigint, $14::bigint,
       'pending', $15, $16, $17, NULL, NULL, $18::uuid
     )`,
    [
      action.nonce,
      action.orgId,
      action.storeId,
      action.command,
      action.commandVersion,
      JSON.stringify(action.args),
      action.authority === undefined ? null : JSON.stringify(action.authority),
      action.authority !== undefined,
      action.argsHash,
      JSON.stringify(action.entityVersions),
      action.creatorStaffId,
      action.idempotencyKey,
      action.createdAt,
      action.expiresAt,
      action.effectiveRisk,
      action.policyOutcome,
      action.requiresOtherApprover,
      action.privacySubjectCustomerId,
    ],
  );
  if (inserted.rowCount !== 1) throw new Error("Unable to persist pending action");
}

async function pruneInvalidActions(
  client: SqlClient,
  tenant: TenantContext,
  nowEpochSeconds: number,
): Promise<number> {
  const retentionCutoff = nowEpochSeconds - PENDING_ACTION_RETENTION_SECONDS;
  const deleted = await client.query(
    `WITH candidates AS (
       SELECT pending.nonce
       FROM ai_pending_actions AS pending
       WHERE pending.org_id = $1::uuid AND pending.store_id = $2::uuid
         AND pending.expires_at_epoch <= $3::bigint
         AND (
           pending.status IN ('pending', 'expired', 'denied')
           OR (
             pending.status = 'consumed'
             -- In-progress claims are transaction-local by schema design and
             -- cannot be committed; only a recent completed result protects replay.
             AND NOT EXISTS (
               SELECT 1
               FROM command_idempotency AS replay
               WHERE replay.org_id = pending.org_id
                 AND replay.store_id = pending.store_id
                 AND replay.command = pending.command
                 AND replay.idempotency_key = pending.idempotency_key
                 AND replay.status = 'completed'
                 AND replay.completed_at > to_timestamp($3::double precision)
             )
           )
         )
       ORDER BY pending.status, pending.expires_at_epoch, pending.nonce
       LIMIT $4
       FOR UPDATE OF pending SKIP LOCKED
     )
     DELETE FROM ai_pending_actions AS pending
     USING candidates
     WHERE pending.nonce = candidates.nonce`,
    [tenant.orgId, tenant.storeId, retentionCutoff, PENDING_ACTION_CLEANUP_BATCH_SIZE],
  );
  return deleted.rowCount ?? 0;
}

/** Create a durable store whose writes must join the bus transaction explicitly. */
export function createPgPendingActionStore(pool: PgPool): PendingActionStore {
  return Object.freeze({
    lockPrivacy: async (transaction) => {
      await lockPendingAuthorities(transaction.client, transaction.tenant);
    },

    measureRiskReservation: async (request, context) => {
      const transaction = requireTransaction(context);
      await lockPendingAuthorities(transaction.client, transaction.tenant);
      return measureNotificationRisk(request, transaction);
    },

    create: async (input, context) => {
      const transaction = requireTransaction(context);
      const action = createPendingActionSnapshot(input);
      assertScope(action, transaction.tenant);
      if (action.creatorStaffId !== transaction.tenant.staffId) {
        throw new Error("Pending action creator does not match authenticated actor");
      }
      await lockPendingAuthorities(transaction.client, transaction.tenant);
      await insertAction(transaction.client, action);
      await pruneInvalidActions(transaction.client, transaction.tenant, action.createdAt);
      return action;
    },

    findByIdempotency: async (command, idempotencyKey, context) => {
      if (context === undefined) {
        throw new Error("PostgreSQL pending action read requires an authenticated tenant");
      }
      if ("client" in context) {
        return selectActionByIdempotency(context.client, context.tenant, command, idempotencyKey);
      }
      return withStoreGucOrCurrent(pool, context.tenant, (client) =>
        selectActionByIdempotency(client, context.tenant, command, idempotencyKey),
      );
    },

    get: async (nonce, context) => {
      if (context === undefined) {
        throw new Error("PostgreSQL pending action read requires an authenticated tenant");
      }
      if ("client" in context) {
        return selectAction(context.client, context.tenant, nonce, false);
      }
      return withStoreGucOrCurrent(pool, context.tenant, (client) =>
        selectAction(client, context.tenant, nonce, false),
      );
    },

    atomicConsume: async (nonce, approverStaffId, options = {}) => {
      const transaction = requireTransaction(options.transaction);
      await lockPendingAuthorities(transaction.client, transaction.tenant);
      const current = await selectAction(transaction.client, transaction.tenant, nonce, true);
      if (current === null) return Object.freeze({ ok: false, reason: "NOT_FOUND" });
      if (current.status === "consumed") {
        return Object.freeze({ ok: false, reason: "ALREADY_CONSUMED" });
      }
      if (current.status === "denied") return Object.freeze({ ok: false, reason: "DENIED" });
      if (current.status === "expired") {
        await transaction.client.query(
          `UPDATE ai_pending_actions SET status = 'expired'
           WHERE nonce = $1::uuid AND org_id = $2::uuid AND store_id = $3::uuid
             AND status = 'pending'`,
          [nonce, transaction.tenant.orgId, transaction.tenant.storeId],
        );
        return Object.freeze({ ok: false, reason: "EXPIRED" });
      }
      if (current.requiresOtherApprover && approverStaffId === current.creatorStaffId) {
        return Object.freeze({ ok: false, reason: "SELF_APPROVE_FORBIDDEN" });
      }
      if (options.expectedArgsHash !== undefined && options.expectedArgsHash !== current.argsHash) {
        return Object.freeze({ ok: false, reason: "ARGS_HASH_MISMATCH" });
      }

      const consumed = await transaction.client.query<PendingActionRow>(
        `UPDATE ai_pending_actions
         SET status = 'consumed', consumed_by_staff_id = $4::uuid,
             consumed_at_epoch = floor(extract(epoch FROM statement_timestamp()))::bigint
         WHERE nonce = $1::uuid AND org_id = $2::uuid AND store_id = $3::uuid
           AND status = 'pending'
           AND expires_at_epoch > floor(extract(epoch FROM statement_timestamp()))::bigint
           AND args_hash = $5
         RETURNING ${SELECT_COLUMNS}`,
        [
          nonce,
          transaction.tenant.orgId,
          transaction.tenant.storeId,
          approverStaffId,
          current.argsHash,
        ],
      );
      const row = consumed.rows[0];
      return row === undefined
        ? Object.freeze({ ok: false, reason: "ALREADY_CONSUMED" })
        : Object.freeze({ ok: true, action: actionFromRow(row) });
    },

    pruneExpired: async (nowEpochSeconds, context) =>
      withStoreGucOrCurrent(pool, context.tenant, (client) =>
        pruneInvalidActions(client, context.tenant, nowEpochSeconds),
      ),

    pruneExpiredGlobally: async () => {
      const result = await pool.query<Readonly<{ deleted_count: string | number }>>(
        "SELECT public.prune_expired_pending_actions_global($1)::text AS deleted_count",
        [PENDING_ACTION_CLEANUP_BATCH_SIZE],
      );
      return Number(result.rows[0]?.deleted_count ?? 0);
    },
  });
}
