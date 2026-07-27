/** Durable, tenant-scoped command idempotency for the local PostgreSQL runtime. */

import type { PgPool } from "../db/pg-pool.js";
import { withStoreGucOrCurrent } from "../db/tenant-guc-client.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import type {
  CommandResult,
  DurableIdempotencyLookup,
  TransactionalIdempotencyStore,
} from "./types.js";

type IdempotencyRow = Readonly<{
  request_hash: string;
  status: "in_progress" | "completed";
  result_json: unknown | null;
}>;

function resultFromJson(value: unknown): CommandResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Persisted idempotency result is not an object");
  }
  const row = value as Readonly<Record<string, unknown>>;
  if (row.ok === true && typeof row.data === "object" && row.data !== null) {
    return value as CommandResult;
  }
  if (row.ok === false && typeof row.error === "object" && row.error !== null) {
    return value as CommandResult;
  }
  throw new Error("Persisted idempotency result is malformed");
}

function lookupRow(row: IdempotencyRow | undefined, requestHash: string): DurableIdempotencyLookup {
  if (row === undefined) return Object.freeze({ kind: "miss" });
  if (row.request_hash !== requestHash) return Object.freeze({ kind: "conflict" });
  if (row.status === "in_progress") return Object.freeze({ kind: "in_progress" });
  if (row.result_json === null) throw new Error("Completed idempotency row has no result");
  return Object.freeze({ kind: "replay", result: resultFromJson(row.result_json) });
}

async function lookup(
  client: SqlClient,
  tenant: TenantContext,
  command: string,
  key: string,
  requestHash: string,
): Promise<DurableIdempotencyLookup> {
  const result = await client.query<IdempotencyRow>(
    `SELECT request_hash, status, result_json
     FROM command_idempotency
     WHERE org_id = $1::uuid AND store_id = $2::uuid
       AND command = $3 AND idempotency_key = $4::uuid
     LIMIT 1`,
    [tenant.orgId, tenant.storeId, command, key],
  );
  return lookupRow(result.rows[0], requestHash);
}

async function claim(
  client: SqlClient,
  tenant: TenantContext,
  command: string,
  key: string,
  requestHash: string,
): Promise<DurableIdempotencyLookup> {
  const inserted = await client.query<Readonly<{ request_hash: string }>>(
    `INSERT INTO command_idempotency (
       org_id, store_id, command, idempotency_key, request_hash, status
     ) VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, 'in_progress')
     ON CONFLICT (org_id, store_id, command, idempotency_key) DO NOTHING
     RETURNING request_hash`,
    [tenant.orgId, tenant.storeId, command, key, requestHash],
  );
  if (inserted.rows[0] !== undefined) return Object.freeze({ kind: "miss" });

  const existing = await client.query<IdempotencyRow>(
    `SELECT request_hash, status, result_json
     FROM command_idempotency
     WHERE org_id = $1::uuid AND store_id = $2::uuid
       AND command = $3 AND idempotency_key = $4::uuid
     FOR UPDATE`,
    [tenant.orgId, tenant.storeId, command, key],
  );
  return lookupRow(existing.rows[0], requestHash);
}

async function complete(
  client: SqlClient,
  tenant: TenantContext,
  command: string,
  key: string,
  requestHash: string,
  result: CommandResult,
): Promise<void> {
  const resultJson = JSON.stringify(result);
  const updated = await client.query(
    `UPDATE command_idempotency
     SET status = 'completed', result_json = $6::jsonb, completed_at = now()
     WHERE org_id = $1::uuid AND store_id = $2::uuid
       AND command = $3 AND idempotency_key = $4::uuid
       AND request_hash = $5 AND status = 'in_progress'`,
    [tenant.orgId, tenant.storeId, command, key, requestHash, resultJson],
  );
  if (updated.rowCount !== 1) throw new Error("Unable to complete idempotency claim");
}

/** Create a durable store; all mutating operations receive the bus transaction client. */
export function createPgIdempotencyStore(pool: PgPool): TransactionalIdempotencyStore {
  return Object.freeze({
    lookup: (tenant, command, key, requestHash) =>
      withStoreGucOrCurrent(pool, tenant, (client) =>
        lookup(client, tenant, command, key, requestHash),
      ),
    claim,
    complete,
  });
}
