/**
 * C3 append-only audit writer.
 * INSERT only — never UPDATE/DELETE (matches laundry_app GRANT on audit_log).
 * Must run inside the same transaction as the business mutation.
 */

import type { SqlClient, Uuid } from "../db/types.js";
import type { CommandVia } from "../bus/types.js";

/** Fixed INSERT — identifiers are literals; values are bound params only. */
export const INSERT_AUDIT_LOG_SQL = Object.freeze(
  `INSERT INTO audit_log (
  id, org_id, store_id, staff_id, via, command, idempotency_key, dry_run,
  entity, entity_id, before_json, after_json, ip, device_id, at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
);

export type AuditWriteRecord = Readonly<{
  id: Uuid;
  orgId: Uuid;
  storeId: Uuid;
  staffId: Uuid | null;
  via: CommandVia;
  command: string;
  idempotencyKey: string | null;
  dryRun: boolean;
  entity: string | null;
  entityId: string | null;
  beforeJson: string | null;
  afterJson: string | null;
  ip: string | null;
  deviceId: Uuid | null;
  at: Date;
}>;

/**
 * Append one audit row. Throws on DB failure so the surrounding txn rolls back.
 * Does not UPDATE or DELETE — grant model relies on DB permissions for immutability.
 */
export async function writeAudit(client: SqlClient, record: AuditWriteRecord): Promise<void> {
  await client.query(INSERT_AUDIT_LOG_SQL, [
    record.id,
    record.orgId,
    record.storeId,
    record.staffId,
    record.via,
    record.command,
    record.idempotencyKey,
    record.dryRun,
    record.entity,
    record.entityId,
    record.beforeJson,
    record.afterJson,
    record.ip,
    record.deviceId,
    record.at.toISOString(),
  ]);
}

/** Guard helpers for static / unit assertions (no SQL mutation verbs). */
export function auditWriterIsInsertOnly(sql: string): boolean {
  const normalized = sql.trim().toUpperCase();
  if (!normalized.startsWith("INSERT")) return false;
  if (/\bUPDATE\b/.test(normalized)) return false;
  if (/\bDELETE\b/.test(normalized)) return false;
  if (/\bTRUNCATE\b/.test(normalized)) return false;
  return true;
}
