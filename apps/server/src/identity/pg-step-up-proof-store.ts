/** PostgreSQL-backed single-use step-up proof authority. */

import type { PgPool } from "../db/pg-pool.js";
import { withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { freezeEntityVersions } from "../pending-actions/store.js";
import type { EntityVersion, PendingActionTransactionContext } from "../pending-actions/types.js";
import type { StepUpProof } from "../policy/step-up.js";
import type { StepUpProofReadContext, StepUpProofStore } from "../policy/step-up-proof-store.js";

type StepUpProofRow = Readonly<{
  proof_id: string;
  org_id: string;
  store_id: string;
  pending_action_ref: string;
  args_hash: string;
  entity_versions_json: unknown;
  idempotency_key: string;
  requester_staff_id: string;
  approver_staff_id: string;
  session_id: string;
  session_version: number;
  issued_at_epoch: string | number;
  expires_at_epoch: string | number;
  status: string;
}>;

const SELECT_COLUMNS = `proof_id::text, org_id::text, store_id::text,
  pending_action_ref::text, args_hash, entity_versions_json,
  idempotency_key::text, requester_staff_id::text, approver_staff_id::text,
  session_id::text, session_version, issued_at_epoch, expires_at_epoch, status`;

function epoch(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Persisted step-up proof ${field} is invalid`);
  }
  return parsed;
}

function entityVersions(value: unknown): readonly EntityVersion[] {
  if (!Array.isArray(value)) {
    throw new Error("Persisted step-up proof entity versions are invalid");
  }
  return freezeEntityVersions(
    value.map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error("Persisted step-up proof entity version is invalid");
      }
      const record = entry as Readonly<Record<string, unknown>>;
      if (
        typeof record.entityType !== "string" ||
        typeof record.entityId !== "string" ||
        typeof record.version !== "number" ||
        !Number.isSafeInteger(record.version) ||
        record.version < 0
      ) {
        throw new Error("Persisted step-up proof entity version is invalid");
      }
      return Object.freeze({
        entityType: record.entityType,
        entityId: record.entityId,
        version: record.version,
      });
    }),
  );
}

function proofFromRow(row: StepUpProofRow): StepUpProof {
  if (row.status !== "active" && row.status !== "consumed") {
    throw new Error("Persisted step-up proof status is invalid");
  }
  if (!Number.isSafeInteger(row.session_version) || row.session_version < 1) {
    throw new Error("Persisted step-up proof session version is invalid");
  }
  return Object.freeze({
    proofId: row.proof_id,
    status: row.status,
    pendingActionRef: row.pending_action_ref,
    argsHash: row.args_hash,
    entityVersions: entityVersions(row.entity_versions_json),
    idempotencyKey: row.idempotency_key,
    requesterStaffId: row.requester_staff_id,
    approverStaffId: row.approver_staff_id,
    orgId: row.org_id,
    storeId: row.store_id,
    sessionId: row.session_id,
    sessionVersion: row.session_version,
    issuedAt: epoch(row.issued_at_epoch, "issued_at_epoch"),
    expiresAt: epoch(row.expires_at_epoch, "expires_at_epoch"),
  });
}

function requireContext(context: StepUpProofReadContext | undefined): StepUpProofReadContext {
  if (context === undefined) {
    throw new Error("PostgreSQL step-up proof access requires an authenticated tenant");
  }
  return context;
}

function requireTransaction(
  transaction: PendingActionTransactionContext | undefined,
): PendingActionTransactionContext {
  if (transaction === undefined) {
    throw new Error("PostgreSQL step-up proof consumption requires the command transaction");
  }
  return transaction;
}

function assertScope(proof: StepUpProof, tenant: TenantContext): void {
  if (proof.orgId !== tenant.orgId || proof.storeId !== tenant.storeId) {
    throw new Error("Step-up proof scope does not match authenticated tenant");
  }
  if (proof.requesterStaffId !== tenant.staffId) {
    throw new Error("Step-up proof requester does not match authenticated actor");
  }
}

async function withContext<T>(
  pool: PgPool,
  context: StepUpProofReadContext,
  run: (client: SqlClient) => Promise<T>,
): Promise<T> {
  if (context.client !== undefined) return run(context.client);
  return withStoreGucOrCurrent(pool, context.tenant, run);
}

async function selectById(
  client: SqlClient,
  tenant: TenantContext,
  proofId: string,
): Promise<StepUpProof | null> {
  const result = await client.query<StepUpProofRow>(
    `SELECT ${SELECT_COLUMNS}
     FROM step_up_proofs
     WHERE org_id = $1::uuid AND store_id = $2::uuid
       AND proof_id = $3::uuid`,
    [tenant.orgId, tenant.storeId, proofId],
  );
  return result.rows[0] === undefined ? null : proofFromRow(result.rows[0]);
}

async function insertProof(client: SqlClient, proof: StepUpProof): Promise<void> {
  const inserted = await client.query(
    `INSERT INTO step_up_proofs (
       proof_id, org_id, store_id, pending_action_ref, args_hash,
       entity_versions_json, idempotency_key, requester_staff_id,
       approver_staff_id, session_id, session_version, issued_at_epoch,
       expires_at_epoch, status, consumed_at_epoch
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::jsonb,
       $7::uuid, $8::uuid, $9::uuid, $10::uuid, $11, $12::bigint,
       $13::bigint, 'active', NULL
     )`,
    [
      proof.proofId,
      proof.orgId,
      proof.storeId,
      proof.pendingActionRef,
      proof.argsHash,
      JSON.stringify(proof.entityVersions),
      proof.idempotencyKey,
      proof.requesterStaffId,
      proof.approverStaffId,
      proof.sessionId,
      proof.sessionVersion,
      proof.issuedAt,
      proof.expiresAt,
    ],
  );
  if (inserted.rowCount !== 1) throw new Error("Unable to persist step-up proof");
}

export function createPgStepUpProofStore(pool: PgPool): StepUpProofStore {
  return Object.freeze({
    insert: async (proof, untrustedContext) => {
      const context = requireContext(untrustedContext);
      assertScope(proof, context.tenant);
      await withContext(pool, context, (client) => insertProof(client, proof));
    },

    get: async (proofId, untrustedContext) => {
      const context = requireContext(untrustedContext);
      return withContext(pool, context, (client) => selectById(client, context.tenant, proofId));
    },

    findActiveByPendingRef: async (pendingActionRef, untrustedContext) => {
      const context = requireContext(untrustedContext);
      return withContext(pool, context, async (client) => {
        const result = await client.query<StepUpProofRow>(
          `SELECT ${SELECT_COLUMNS}
           FROM step_up_proofs
           WHERE org_id = $1::uuid AND store_id = $2::uuid
             AND pending_action_ref = $3::uuid AND status = 'active'
           ORDER BY issued_at_epoch DESC, proof_id DESC
           LIMIT 1`,
          [context.tenant.orgId, context.tenant.storeId, pendingActionRef],
        );
        return result.rows[0] === undefined ? null : proofFromRow(result.rows[0]);
      });
    },

    atomicConsume: async (proofId, nowEpochSeconds, untrustedTransaction) => {
      const transaction = requireTransaction(untrustedTransaction);
      const consumed = await transaction.client.query(
        `UPDATE step_up_proofs
         SET status = 'consumed', consumed_at_epoch = $4::bigint
         WHERE proof_id = $1::uuid AND org_id = $2::uuid AND store_id = $3::uuid
           AND status = 'active' AND issued_at_epoch <= $4::bigint
           AND expires_at_epoch > $4::bigint`,
        [proofId, transaction.tenant.orgId, transaction.tenant.storeId, nowEpochSeconds],
      );
      return consumed.rowCount === 1;
    },
  });
}
