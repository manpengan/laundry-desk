import type { PgPool } from "../db/pg-pool.js";
import { withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { freezeCanonical } from "../pending-actions/canonical.js";
import { freezeEntityVersions } from "../pending-actions/store.js";
import type { EntityVersion } from "../pending-actions/types.js";
import {
  ApprovalStoreError,
  type ApprovalContext,
  type ApprovalRequest,
  type ApprovalStatus,
  type ApprovalStore,
  type ApprovalTransaction,
} from "./types.js";

type ApprovalRow = Readonly<{
  approval_ref: string;
  org_id: string;
  store_id: string;
  pending_action_ref: string;
  command: string;
  command_version: string;
  args_json: unknown;
  args_hash: string;
  entity_versions_json: unknown;
  idempotency_key: string;
  requester_staff_id: string;
  requester_permission_version: number;
  effective_status: string;
  row_version: number;
  created_at_epoch: string | number;
  expires_at_epoch: string | number;
  decided_by_staff_id: string | null;
  decided_by_permission_version: number | null;
  decided_at_epoch: string | number | null;
  decision_reason: string | null;
  consumed_at_epoch: string | number | null;
}>;

const SELECT_COLUMNS = `approval_ref::text, org_id::text, store_id::text,
  pending_action_ref::text, command, command_version, args_json, args_hash,
  entity_versions_json, idempotency_key::text, requester_staff_id::text,
  requester_permission_version,
  CASE WHEN status = 'pending'
    AND expires_at_epoch <= floor(extract(epoch FROM statement_timestamp()))::bigint
    THEN 'expired' ELSE status END AS effective_status,
  row_version, created_at_epoch, expires_at_epoch,
  decided_by_staff_id::text, decided_by_permission_version, decided_at_epoch,
  decision_reason, consumed_at_epoch`;

function epoch(value: string | number | null, field: string): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Persisted approval ${field} is invalid`);
  }
  return parsed;
}

function status(value: string): ApprovalStatus {
  if (
    value === "pending" ||
    value === "approved" ||
    value === "denied" ||
    value === "expired" ||
    value === "consumed"
  ) {
    return value;
  }
  throw new Error("Persisted approval status is invalid");
}

function entityVersions(value: unknown): readonly EntityVersion[] {
  if (!Array.isArray(value)) throw new Error("Persisted approval entity versions are invalid");
  return freezeEntityVersions(
    value.map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error("Persisted approval entity version is invalid");
      }
      const row = entry as Readonly<Record<string, unknown>>;
      if (
        typeof row.entityType !== "string" ||
        typeof row.entityId !== "string" ||
        typeof row.version !== "number" ||
        !Number.isSafeInteger(row.version) ||
        row.version < 0
      ) {
        throw new Error("Persisted approval entity version is invalid");
      }
      return Object.freeze({
        entityType: row.entityType,
        entityId: row.entityId,
        version: row.version,
      });
    }),
  );
}

function requestFromRow(row: ApprovalRow): ApprovalRequest {
  return Object.freeze({
    approvalRef: row.approval_ref,
    orgId: row.org_id,
    storeId: row.store_id,
    pendingActionRef: row.pending_action_ref,
    command: row.command,
    commandVersion: row.command_version,
    args: freezeCanonical(row.args_json),
    argsHash: row.args_hash,
    entityVersions: entityVersions(row.entity_versions_json),
    idempotencyKey: row.idempotency_key,
    requesterStaffId: row.requester_staff_id,
    requesterPermissionVersion: row.requester_permission_version,
    status: status(row.effective_status),
    rowVersion: row.row_version,
    createdAt: epoch(row.created_at_epoch, "created_at_epoch")!,
    expiresAt: epoch(row.expires_at_epoch, "expires_at_epoch")!,
    decidedByStaffId: row.decided_by_staff_id,
    decidedByPermissionVersion: row.decided_by_permission_version,
    decidedAt: epoch(row.decided_at_epoch, "decided_at_epoch"),
    decisionReason: row.decision_reason,
    consumedAt: epoch(row.consumed_at_epoch, "consumed_at_epoch"),
  });
}

async function selectRequest(
  client: SqlClient,
  tenant: TenantContext,
  approvalRef: string,
): Promise<ApprovalRequest | null> {
  const result = await client.query<ApprovalRow>(
    `SELECT ${SELECT_COLUMNS}
       FROM public.ai_approval_requests
      WHERE org_id = $1::uuid AND store_id = $2::uuid AND approval_ref = $3::uuid`,
    [tenant.orgId, tenant.storeId, approvalRef],
  );
  return result.rows[0] === undefined ? null : requestFromRow(result.rows[0]);
}

function requireTransaction(context: ApprovalTransaction | undefined): ApprovalTransaction {
  if (context === undefined) throw new Error("Approval mutation requires an active transaction");
  return context;
}

async function withContext<T>(
  pool: PgPool,
  context: ApprovalContext,
  operation: (client: SqlClient) => Promise<T>,
): Promise<T> {
  if (context.client !== undefined) return operation(context.client);
  return withStoreGucOrCurrent(pool, context.tenant, operation);
}

function mapDatabaseError(error: unknown): never {
  const message = error instanceof Error ? error.message : "";
  if (/request unavailable/iu.test(message)) throw new ApprovalStoreError("NOT_FOUND");
  if (/self approval forbidden/iu.test(message)) {
    throw new ApprovalStoreError("SELF_APPROVE_FORBIDDEN");
  }
  if (/version conflict/iu.test(message)) throw new ApprovalStoreError("VERSION_CONFLICT");
  if (/expired/iu.test(message)) throw new ApprovalStoreError("EXPIRED");
  if (/already decided/iu.test(message)) throw new ApprovalStoreError("ALREADY_DECIDED");
  if (
    /authority changed|administrator unavailable|approved R4 authority unavailable/iu.test(message)
  ) {
    throw new ApprovalStoreError("AUTHORITY_CHANGED");
  }
  if (/R4 pending action unavailable/iu.test(message)) {
    throw new ApprovalStoreError("INVALID_PENDING");
  }
  if (/requester unavailable/iu.test(message)) throw new ApprovalStoreError("INVALID_PENDING");
  throw error;
}

export function createPgApprovalStore(pool: PgPool): ApprovalStore {
  return Object.freeze({
    create: async (approvalRef, pending, _permissionVersion, untrustedContext) => {
      const context = requireTransaction(untrustedContext);
      try {
        const result = await context.client.query<Readonly<{ approval_ref: string }>>(
          `SELECT public.ai_approval_request_create($1::uuid, $2::uuid)::text AS approval_ref`,
          [approvalRef, pending.nonce],
        );
        const resolvedRef = result.rows[0]?.approval_ref;
        if (resolvedRef === undefined) throw new Error("Approval creation returned no authority");
        const created = await selectRequest(context.client, context.tenant, resolvedRef);
        if (created === null) throw new Error("Approval creation was not persisted");
        return created;
      } catch (error) {
        mapDatabaseError(error);
      }
    },

    get: async (approvalRef, _now, context) =>
      withContext(pool, context, (client) => selectRequest(client, context.tenant, approvalRef)),

    list: async (scope, limit, _now, context) =>
      withContext(pool, context, async (client) => {
        const predicate =
          scope === "pending"
            ? `status = 'pending'
               AND expires_at_epoch > floor(extract(epoch FROM statement_timestamp()))::bigint`
            : `(status <> 'pending'
               OR expires_at_epoch <= floor(extract(epoch FROM statement_timestamp()))::bigint)`;
        const result = await client.query<ApprovalRow>(
          `SELECT ${SELECT_COLUMNS}
             FROM public.ai_approval_requests
            WHERE org_id = $1::uuid AND store_id = $2::uuid AND ${predicate}
            ORDER BY created_at_epoch DESC, approval_ref DESC
            LIMIT $3`,
          [context.tenant.orgId, context.tenant.storeId, limit],
        );
        return Object.freeze(result.rows.map(requestFromRow));
      }),

    decide: async (
      approvalRef,
      expectedVersion,
      decision,
      reason,
      _permissionVersion,
      _now,
      untrustedContext,
    ) => {
      const context = requireTransaction(untrustedContext);
      try {
        await context.client.query(
          `SELECT public.ai_approval_request_decide($1::uuid, $2, $3, $4)`,
          [approvalRef, expectedVersion, decision, reason],
        );
        const decided = await selectRequest(context.client, context.tenant, approvalRef);
        if (decided === null) throw new ApprovalStoreError("NOT_FOUND");
        return decided;
      } catch (error) {
        mapDatabaseError(error);
      }
    },

    consume: async (approvalRef, pending, _now, untrustedContext) => {
      const context = requireTransaction(untrustedContext);
      try {
        const result = await context.client.query<Readonly<{ approver_staff_id: string }>>(
          `SELECT public.ai_approval_request_consume(
             $1::uuid, $2::uuid, $3, $4::jsonb, $5::uuid
           )::text AS approver_staff_id`,
          [
            approvalRef,
            pending.nonce,
            pending.argsHash,
            JSON.stringify(pending.entityVersions),
            pending.idempotencyKey,
          ],
        );
        const approverStaffId = result.rows[0]?.approver_staff_id;
        if (approverStaffId === undefined) throw new ApprovalStoreError("AUTHORITY_CHANGED");
        const approval = await selectRequest(context.client, context.tenant, approvalRef);
        if (approval === null) throw new ApprovalStoreError("NOT_FOUND");
        return Object.freeze({ approverStaffId, approval });
      } catch (error) {
        mapDatabaseError(error);
      }
    },
  });
}
