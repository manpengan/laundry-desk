import {
  AiCredentialMetadataSchema,
  AiModelMetadataSchema,
  type AiCredentialMetadata,
  type AiModelMetadata,
} from "@laundry/contracts";

import type { PgPool } from "../db/pg-pool.js";
import { withOrgGucOrCurrent } from "../db/tenant-guc-client.js";
import type { SqlClient } from "../db/types.js";
import type {
  ByokStore,
  ByokStoreContext,
  ByokTransactionContext,
  StoredCredential,
} from "./byok-types.js";

type CredentialRow = Readonly<{
  id: string;
  org_id: string;
  provider_code: string;
  credential_version: number;
  row_version: number;
  status: StoredCredential["status"];
  ciphertext: Buffer;
  nonce: Buffer;
  auth_tag: Buffer;
  wrapped_dek: Buffer;
  kms_key_id: string;
  kms_key_version: string;
  envelope_schema_version: 1;
  last4: string;
  created_by_staff_id: string;
  created_at: Date;
  updated_by_staff_id: string;
  updated_at: Date;
  activated_at: Date | null;
  revoked_at: Date | null;
  superseded_at: Date | null;
}>;

const CREDENTIAL_COLUMNS = `id::text, org_id::text, provider_code, credential_version,
  row_version, status, ciphertext, nonce, auth_tag, wrapped_dek, kms_key_id,
  kms_key_version, envelope_schema_version, last4, created_by_staff_id::text,
  created_at, updated_by_staff_id::text, updated_at, activated_at, revoked_at, superseded_at`;
const MAX_MODELS = 500;
const MAX_CREDENTIALS_PER_ORG = 500;
const MAX_CREDENTIALS_PER_PROVIDER = 100;

function requireBounded<T>(rows: readonly T[], maximum: number, label: string): readonly T[] {
  if (rows.length > maximum) throw new Error(`${label} exceeds the bounded read limit`);
  return rows;
}

function metadataFromRow(row: Record<string, unknown>): AiCredentialMetadata {
  return AiCredentialMetadataSchema.parse({
    ...row,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  });
}

function credentialFromRow(row: CredentialRow): StoredCredential {
  if (
    !Buffer.isBuffer(row.ciphertext) ||
    !Buffer.isBuffer(row.nonce) ||
    !Buffer.isBuffer(row.auth_tag) ||
    !Buffer.isBuffer(row.wrapped_dek) ||
    !(row.created_at instanceof Date) ||
    !(row.updated_at instanceof Date)
  ) {
    throw new Error("Persisted credential envelope is invalid");
  }
  return Object.freeze({
    id: row.id,
    orgId: row.org_id,
    providerCode: row.provider_code,
    credentialVersion: row.credential_version,
    rowVersion: row.row_version,
    status: row.status,
    envelope: Object.freeze({
      ciphertext: Buffer.from(row.ciphertext),
      nonce: Buffer.from(row.nonce),
      authTag: Buffer.from(row.auth_tag),
      wrappedDek: Buffer.from(row.wrapped_dek),
      kmsKeyId: row.kms_key_id,
      kmsKeyVersion: row.kms_key_version,
      schemaVersion: row.envelope_schema_version,
    }),
    last4: row.last4,
    createdByStaffId: row.created_by_staff_id,
    createdAt: new Date(row.created_at),
    updatedByStaffId: row.updated_by_staff_id,
    updatedAt: new Date(row.updated_at),
    activatedAt: row.activated_at === null ? null : new Date(row.activated_at),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at),
    supersededAt: row.superseded_at === null ? null : new Date(row.superseded_at),
  });
}

function transactionClient(context: ByokTransactionContext): SqlClient {
  if (context.client === undefined) throw new Error("Credential mutation requires a transaction");
  return context.client;
}

async function withContext<T>(
  pool: PgPool,
  context: ByokStoreContext,
  run: (client: SqlClient) => Promise<T>,
): Promise<T> {
  if (context.client !== undefined) return run(context.client);
  return withOrgGucOrCurrent(
    pool,
    { orgId: context.tenant.orgId, staffId: context.tenant.staffId },
    run,
  );
}

async function selectCredential(
  client: SqlClient,
  orgId: string,
  id: string,
  forUpdate = false,
): Promise<StoredCredential | null> {
  const result = await client.query<CredentialRow>(
    `SELECT ${CREDENTIAL_COLUMNS}
       FROM ai_provider_keys
      WHERE org_id = $1::uuid AND id = $2::uuid
      ${forUpdate ? "FOR UPDATE" : ""}`,
    [orgId, id],
  );
  const row = result.rows[0];
  return row === undefined ? null : credentialFromRow(row);
}

export function createPgByokStore(pool: PgPool): ByokStore {
  return Object.freeze({
    listModels: async () => {
      const result = await pool.query(
        `SELECT provider_code, model_id, display_name, adapter_family,
                supports_streaming, supports_tools, supports_vision,
                max_input_tokens, max_output_tokens, status, registry_version,
                source_url, verified_at
           FROM ai_model_registry
          ORDER BY provider_code, model_id
          LIMIT ${MAX_MODELS + 1}`,
      );
      const rows = requireBounded(result.rows, MAX_MODELS, "Model registry");
      const models: AiModelMetadata[] = rows.map((row: Record<string, unknown>) =>
        AiModelMetadataSchema.parse({
          ...row,
          verified_at:
            row.verified_at instanceof Date ? row.verified_at.toISOString() : row.verified_at,
        }),
      );
      return Object.freeze(models);
    },

    listCredentialMetadata: async (context) =>
      withContext(pool, context, async (client) => {
        const result = await client.query<Record<string, unknown>>(
          `SELECT id::text AS credential_ref, provider_code, credential_version,
                  status, last4, created_at, updated_at
             FROM ai_provider_keys
            WHERE org_id = $1::uuid
            ORDER BY provider_code, credential_version DESC
            LIMIT ${MAX_CREDENTIALS_PER_ORG + 1}`,
          [context.tenant.orgId],
        );
        const metadata: AiCredentialMetadata[] = requireBounded(
          result.rows,
          MAX_CREDENTIALS_PER_ORG,
          "Credential history",
        ).map(metadataFromRow);
        return Object.freeze(metadata);
      }),

    findCredentialMetadata: async (id, context) =>
      withContext(pool, context, async (client) => {
        const result = await client.query<Record<string, unknown>>(
          `SELECT id::text AS credential_ref, provider_code, credential_version,
                  status, last4, created_at, updated_at
             FROM ai_provider_keys
            WHERE org_id = $1::uuid AND id = $2::uuid`,
          [context.tenant.orgId, id],
        );
        const row = result.rows[0];
        return row === undefined ? null : metadataFromRow(row);
      }),

    findCredential: async (id, context) =>
      withContext(pool, context, (client) => selectCredential(client, context.tenant.orgId, id)),

    nextCredentialVersion: async (providerCode, context) => {
      const version = await context.client.query<Readonly<{ next_version: number }>>(
        `SELECT COALESCE(MAX(credential_version), 0)::integer + 1 AS next_version
           FROM ai_provider_keys
          WHERE org_id = $1::uuid AND provider_code = $2`,
        [context.tenant.orgId, providerCode],
      );
      const next = version.rows[0]?.next_version;
      if (next === undefined || !Number.isSafeInteger(next) || next < 1) {
        throw new Error("Credential version authority is invalid");
      }
      return next;
    },

    snapshotProvider: async (providerCode, context) =>
      withContext(pool, context, async (client) => {
        if (context.client !== undefined) {
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
            `${context.tenant.orgId}|${providerCode}`,
          ]);
        }
        const result = await client.query<Readonly<{ id: string; row_version: number }>>(
          `SELECT id::text, row_version
             FROM ai_provider_keys
            WHERE org_id = $1::uuid AND provider_code = $2
            ORDER BY id
            LIMIT ${MAX_CREDENTIALS_PER_PROVIDER + 1}
            ${context.client === undefined ? "" : "FOR UPDATE"}`,
          [context.tenant.orgId, providerCode],
        );
        const rows = requireBounded(
          result.rows,
          MAX_CREDENTIALS_PER_PROVIDER,
          "Provider credential history",
        );
        return Object.freeze(
          rows.map((row) =>
            Object.freeze({
              entityType: "ai_provider_key" as const,
              entityId: row.id,
              version: row.row_version,
            }),
          ),
        );
      }),

    stageCredential: async (record, context) => {
      const client = transactionClient(context);
      const inserted = await client.query<Readonly<{ credential_ref: string }>>(
        `SELECT public.ai_provider_key_stage(
           $1::uuid, $2, $3, $4::bytea, $5::bytea, $6::bytea,
           $7::bytea, $8, $9, $10, $11
         )::text AS credential_ref`,
        [
          record.id,
          record.providerCode,
          record.credentialVersion,
          record.envelope.ciphertext,
          record.envelope.nonce,
          record.envelope.authTag,
          record.envelope.wrappedDek,
          record.envelope.kmsKeyId,
          record.envelope.kmsKeyVersion,
          record.envelope.schemaVersion,
          record.last4,
        ],
      );
      if (inserted.rows[0]?.credential_ref !== record.id) {
        throw new Error("Unable to persist credential");
      }
    },

    revokeCredential: async (id, _actorStaffId, _now, context) => {
      const client = transactionClient(context);
      const target = await selectCredential(client, context.tenant.orgId, id);
      if (target === null) return null;
      const result = await client.query<Readonly<{ changed: boolean }>>(
        `SELECT public.ai_provider_key_revoke($1::uuid, $2, $3) AS changed`,
        [id, target.providerCode, target.rowVersion],
      );
      if (result.rows[0]?.changed !== true) return null;
      const changed = await selectCredential(client, context.tenant.orgId, id);
      return changed === null
        ? null
        : metadataFromRow({
            credential_ref: changed.id,
            provider_code: changed.providerCode,
            credential_version: changed.credentialVersion,
            status: changed.status,
            last4: changed.last4,
            created_at: changed.createdAt,
            updated_at: changed.updatedAt,
          });
    },

    activateCredential: async (id, _actorStaffId, _now, context) => {
      const client = transactionClient(context);
      const target = await selectCredential(client, context.tenant.orgId, id);
      if (target === null || target.status !== "pending_verification") return null;
      const result = await client.query<Readonly<{ changed: boolean }>>(
        `SELECT public.ai_provider_key_verify_transition($1::uuid, $2, 'active') AS changed`,
        [id, target.rowVersion],
      );
      if (result.rows[0]?.changed !== true) return null;
      return selectCredential(client, context.tenant.orgId, id);
    },

    rewrapCredential: async (id, expectedRowVersion, replacement, _actorStaffId, _now, context) => {
      const client = transactionClient(context);
      const result = await client.query<Readonly<{ changed: boolean }>>(
        `SELECT public.ai_provider_key_rewrap(
           $1::uuid, $2, $3::bytea, $4, $5
         ) AS changed`,
        [
          id,
          expectedRowVersion,
          replacement.wrappedDek,
          replacement.kmsKeyId,
          replacement.kmsKeyVersion,
        ],
      );
      if (result.rows[0]?.changed !== true) return null;
      return selectCredential(client, context.tenant.orgId, id);
    },
  });
}
