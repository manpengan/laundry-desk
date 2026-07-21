/**
 * C7 read-only audit list. Never returns tokens, passwords, refresh proofs,
 * or other secret fields — strip at the projection boundary.
 */

import type { SqlClient } from "../db/types.js";

/** Safe audit list item — no before/after secret payloads on the wire. */
export type AuditListItem = Readonly<{
  id: string;
  at_epoch_s: number;
  command: string;
  staff_id: string | null;
  via: string | null;
  entity: string | null;
  entity_id: string | null;
  /** Redacted marker only — never raw token/password JSON. */
  has_diff: boolean;
}>;

export type AuditListFilter = Readonly<{
  orgId: string;
  storeId: string;
  fromEpochS: number;
  toEpochS: number;
  limit: number;
}>;

export type AuditQueryStore = Readonly<{
  list: (filter: AuditListFilter) => Promise<readonly AuditListItem[]>;
  /** Test seed only — append-only in memory. */
  append?: (item: AuditListItem) => void;
}>;

const SECRET_KEY_PATTERN =
  /(?:password|passwd|secret|token|refresh|access_token|csrf|pin|api_key|private_key)/iu;

/** True when a JSON string looks like it embeds credential material. */
export function jsonLooksSecret(json: string | null | undefined): boolean {
  if (json === null || json === undefined || json.length === 0) return false;
  return SECRET_KEY_PATTERN.test(json);
}

/**
 * Project a raw audit row into a safe list item.
 * Drops before_json / after_json bodies; only exposes has_diff.
 */
export function projectAuditListItem(
  raw: Readonly<{
    id: string;
    at_epoch_s: number;
    command: string;
    staff_id?: string | null;
    via?: string | null;
    entity?: string | null;
    entity_id?: string | null;
    before_json?: string | null;
    after_json?: string | null;
  }>,
): AuditListItem {
  const hasDiff =
    (raw.before_json !== null && raw.before_json !== undefined && raw.before_json.length > 0) ||
    (raw.after_json !== null && raw.after_json !== undefined && raw.after_json.length > 0);

  return Object.freeze({
    id: raw.id,
    at_epoch_s: raw.at_epoch_s,
    command: raw.command,
    staff_id: raw.staff_id ?? null,
    via: raw.via ?? null,
    entity: raw.entity ?? null,
    entity_id: raw.entity_id ?? null,
    has_diff: hasDiff,
  });
}

/** Guard: serialized audit list payload must not contain secret substrings. */
export function assertAuditPayloadSafe(payload: unknown): void {
  const text = JSON.stringify(payload);
  if (SECRET_KEY_PATTERN.test(text)) {
    throw new Error("audit query projection leaked a secret-classified field");
  }
}

/** In-memory append-only audit log for skeleton tests. */
export function createMemoryAuditQueryStore(
  initial: readonly AuditListItem[] = [],
): AuditQueryStore {
  const rows: AuditListItem[] = [...initial];
  return Object.freeze({
    async list(filter: AuditListFilter): Promise<readonly AuditListItem[]> {
      const limit = Math.min(Math.max(filter.limit, 1), 200);
      const matched = rows
        .filter((row) => row.at_epoch_s >= filter.fromEpochS && row.at_epoch_s <= filter.toEpochS)
        .sort((a, b) => a.at_epoch_s - b.at_epoch_s)
        .slice(0, limit)
        .map((row) => projectAuditListItem(row));
      assertAuditPayloadSafe(matched);
      return Object.freeze(matched);
    },
    append(item: AuditListItem): void {
      rows.push(projectAuditListItem(item));
    },
  });
}

/** SqlClient skeleton — SELECT safe columns only (no before_json/after_json). */
export function createSqlAuditQueryStore(client: SqlClient): AuditQueryStore {
  return Object.freeze({
    async list(filter: AuditListFilter): Promise<readonly AuditListItem[]> {
      const limit = Math.min(Math.max(filter.limit, 1), 200);
      const result = await client.query<{
        id: string;
        at_epoch_s: number;
        command: string;
        staff_id: string | null;
        via: string | null;
        entity: string | null;
        entity_id: string | null;
        has_diff: boolean;
      }>(
        `SELECT id,
                EXTRACT(EPOCH FROM at)::bigint AS at_epoch_s,
                command,
                staff_id,
                via,
                entity,
                entity_id,
                (before_json IS NOT NULL OR after_json IS NOT NULL) AS has_diff
           FROM audit_log
          WHERE org_id = $1
            AND store_id = $2
            AND EXTRACT(EPOCH FROM at) >= $3
            AND EXTRACT(EPOCH FROM at) <= $4
          ORDER BY at ASC
          LIMIT $5`,
        [filter.orgId, filter.storeId, filter.fromEpochS, filter.toEpochS, limit],
      );
      const items = result.rows.map((row) =>
        projectAuditListItem({
          id: row.id,
          at_epoch_s: Number(row.at_epoch_s),
          command: row.command,
          staff_id: row.staff_id,
          via: row.via,
          entity: row.entity,
          entity_id: row.entity_id,
          before_json: row.has_diff ? "{}" : null,
          after_json: null,
        }),
      );
      assertAuditPayloadSafe(items);
      return Object.freeze(items);
    },
  });
}
