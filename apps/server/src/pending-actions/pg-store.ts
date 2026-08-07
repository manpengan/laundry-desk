/** PostgreSQL-backed WYSIWYS confirmation authority. */

import type { RiskLevel } from "@laundry/domain";

import type { PgPool } from "../db/pg-pool.js";
import { withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import type { PolicyOutcome } from "../policy/types.js";
import { freezeCanonical, hashCanonical } from "./canonical.js";
import { createPendingActionSnapshot, freezeEntityVersions, freezePendingAction } from "./store.js";
import type {
  EntityVersion,
  PendingAction,
  PendingActionStatus,
  PendingActionStore,
  PendingActionTransactionContext,
} from "./types.js";

type PendingActionRow = Readonly<{
  nonce: string;
  command: string;
  command_version: string;
  args_json: unknown;
  authority_json: unknown | null;
  authority_present: boolean;
  args_hash: string;
  entity_versions_json: unknown;
  creator_staff_id: string;
  org_id: string;
  store_id: string;
  idempotency_key: string;
  created_at_epoch: string | number;
  expires_at_epoch: string | number;
  status: string;
  effective_risk: string;
  policy_outcome: string;
  requires_other_approver: boolean;
  consumed_by_staff_id: string | null;
  consumed_at_epoch: string | number | null;
}>;

const SELECT_COLUMNS = `nonce::text, command, command_version, args_json,
  authority_json, authority_present, args_hash, entity_versions_json,
  creator_staff_id::text, org_id::text, store_id::text, idempotency_key::text,
  created_at_epoch, expires_at_epoch, status, effective_risk, policy_outcome,
  requires_other_approver, consumed_by_staff_id::text, consumed_at_epoch`;

/**
 * Invalid cards remain available for operational diagnosis for 30 days.
 * Recent durable idempotency state keeps a consumed card replayable for the
 * same 30-day window; older frozen args are eligible for bounded cleanup.
 */
export const PENDING_ACTION_RETENTION_SECONDS = 30 * 24 * 60 * 60;
export const PENDING_ACTION_CLEANUP_BATCH_SIZE = 100;

function epoch(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Persisted pending action ${field} is invalid`);
  }
  return parsed;
}

function status(value: string): PendingActionStatus {
  if (value === "pending" || value === "consumed" || value === "expired" || value === "denied") {
    return value;
  }
  throw new Error("Persisted pending action status is invalid");
}

function risk(value: string): RiskLevel {
  if (
    value === "R0" ||
    value === "R1" ||
    value === "R2" ||
    value === "R3" ||
    value === "R4" ||
    value === "R5"
  ) {
    return value;
  }
  throw new Error("Persisted pending action risk is invalid");
}

function policyOutcome(value: string): Extract<PolicyOutcome, "confirm" | "step_up"> {
  if (value === "confirm" || value === "step_up") return value;
  throw new Error("Persisted pending action policy outcome is invalid");
}

function entityVersions(value: unknown): readonly EntityVersion[] {
  if (!Array.isArray(value)) {
    throw new Error("Persisted pending action entity versions are invalid");
  }
  return freezeEntityVersions(
    value.map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error("Persisted pending action entity version is invalid");
      }
      const record = entry as Readonly<Record<string, unknown>>;
      if (
        typeof record.entityType !== "string" ||
        typeof record.entityId !== "string" ||
        typeof record.version !== "number" ||
        !Number.isSafeInteger(record.version) ||
        record.version < 0
      ) {
        throw new Error("Persisted pending action entity version is invalid");
      }
      return Object.freeze({
        entityType: record.entityType,
        entityId: record.entityId,
        version: record.version,
      });
    }),
  );
}

function actionFromRow(row: PendingActionRow): PendingAction {
  const args = freezeCanonical(row.args_json);
  const authority = row.authority_present ? freezeCanonical(row.authority_json) : undefined;
  const calculatedHash = hashCanonical(
    authority === undefined ? args : Object.freeze({ args, authority }),
  );
  if (calculatedHash !== row.args_hash) {
    throw new Error("Persisted pending action hash is invalid");
  }
  const parsedStatus = status(row.status);
  const consumedAt =
    row.consumed_at_epoch === null ? null : epoch(row.consumed_at_epoch, "consumed_at_epoch");
  if (
    (parsedStatus === "consumed" && (row.consumed_by_staff_id === null || consumedAt === null)) ||
    (parsedStatus !== "consumed" && (row.consumed_by_staff_id !== null || consumedAt !== null))
  ) {
    throw new Error("Persisted pending action consumption state is invalid");
  }
  return freezePendingAction({
    nonce: row.nonce,
    command: row.command,
    commandVersion: row.command_version,
    args,
    ...(authority === undefined ? {} : { authority }),
    argsHash: row.args_hash,
    entityVersions: entityVersions(row.entity_versions_json),
    creatorStaffId: row.creator_staff_id,
    orgId: row.org_id,
    storeId: row.store_id,
    idempotencyKey: row.idempotency_key,
    createdAt: epoch(row.created_at_epoch, "created_at_epoch"),
    expiresAt: epoch(row.expires_at_epoch, "expires_at_epoch"),
    status: parsedStatus,
    effectiveRisk: risk(row.effective_risk),
    policyOutcome: policyOutcome(row.policy_outcome),
    requiresOtherApprover: row.requires_other_approver,
    consumedByStaffId: row.consumed_by_staff_id,
    consumedAt,
  });
}

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
  const result = await client.query<PendingActionRow>(
    `SELECT ${SELECT_COLUMNS}
     FROM ai_pending_actions
     WHERE nonce = $1::uuid AND org_id = $2::uuid AND store_id = $3::uuid
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [nonce, tenant.orgId, tenant.storeId],
  );
  return result.rows[0] === undefined ? null : actionFromRow(result.rows[0]);
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
       consumed_by_staff_id, consumed_at_epoch
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb,
       $7::jsonb, $8, $9, $10::jsonb,
       $11::uuid, $12::uuid, $13::bigint, $14::bigint,
       'pending', $15, $16, $17, NULL, NULL
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
    ],
  );
  if (inserted.rowCount !== 1) throw new Error("Unable to persist pending action");
}

async function pruneInvalidActions(
  client: SqlClient,
  tenant: TenantContext,
  nowEpochSeconds: number,
): Promise<void> {
  const retentionCutoff = nowEpochSeconds - PENDING_ACTION_RETENTION_SECONDS;
  await client.query(
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
}

/** Create a durable store whose writes must join the bus transaction explicitly. */
export function createPgPendingActionStore(pool: PgPool): PendingActionStore {
  return Object.freeze({
    create: async (input, context) => {
      const transaction = requireTransaction(context);
      const action = createPendingActionSnapshot(input);
      assertScope(action, transaction.tenant);
      if (action.creatorStaffId !== transaction.tenant.staffId) {
        throw new Error("Pending action creator does not match authenticated actor");
      }
      await insertAction(transaction.client, action);
      await pruneInvalidActions(transaction.client, transaction.tenant, action.createdAt);
      return action;
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
      const current = await selectAction(transaction.client, transaction.tenant, nonce, true);
      if (current === null) return Object.freeze({ ok: false, reason: "NOT_FOUND" });
      const now = options.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
      if (current.status === "consumed") {
        return Object.freeze({ ok: false, reason: "ALREADY_CONSUMED" });
      }
      if (current.status === "denied") return Object.freeze({ ok: false, reason: "DENIED" });
      if (current.status === "expired" || now >= current.expiresAt) {
        if (current.status === "pending") {
          await transaction.client.query(
            `UPDATE ai_pending_actions SET status = 'expired'
             WHERE nonce = $1::uuid AND org_id = $2::uuid AND store_id = $3::uuid
               AND status = 'pending'`,
            [nonce, transaction.tenant.orgId, transaction.tenant.storeId],
          );
        }
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
         SET status = 'consumed', consumed_by_staff_id = $4::uuid, consumed_at_epoch = $5::bigint
         WHERE nonce = $1::uuid AND org_id = $2::uuid AND store_id = $3::uuid
           AND status = 'pending' AND args_hash = $6
         RETURNING ${SELECT_COLUMNS}`,
        [
          nonce,
          transaction.tenant.orgId,
          transaction.tenant.storeId,
          approverStaffId,
          now,
          current.argsHash,
        ],
      );
      const row = consumed.rows[0];
      return row === undefined
        ? Object.freeze({ ok: false, reason: "ALREADY_CONSUMED" })
        : Object.freeze({ ok: true, action: actionFromRow(row) });
    },
  });
}
