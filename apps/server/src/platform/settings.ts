/**
 * C7 settings store — key/value_json map with amount-in-cents integer guard.
 * Persistence is injected (memory map for tests; SqlClient + tenant for PG).
 * Routes must not call mutators directly — use createPlatformHandlers / bus.
 */

import { randomUUID } from "node:crypto";

import type { SqlClient, TenantContext } from "../db/types.js";

/** Settings wire values are JSON strings (A6 value_json). */
export type SettingsEntry = Readonly<{
  key: string;
  value_json: string;
}>;

export type SettingsStore = Readonly<{
  getMany: (keys: readonly string[]) => Promise<Readonly<Record<string, string>>>;
  setMany: (entries: readonly SettingsEntry[]) => Promise<void>;
}>;

/** Keys that store money must end with `_cents` and carry integer JSON numbers. */
const AMOUNT_KEY = /(?:^|\.)[a-z0-9_]*_cents$/u;

export function isAmountSettingsKey(key: string): boolean {
  return AMOUNT_KEY.test(key);
}

/**
 * Parse value_json and enforce integer-cents for amount keys.
 * Throws TypeError on float / non-integer amount values.
 */
export function parseSettingsValueJson(key: string, valueJson: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(valueJson) as unknown;
  } catch {
    throw new TypeError(`settings value_json for ${key} is not valid JSON`);
  }
  if (isAmountSettingsKey(key)) {
    assertAmountInt(key, parsed);
  }
  return parsed;
}

/** Amount values must be safe integers (fen/cents) — zero float. */
export function assertAmountInt(key: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw new TypeError(
      `settings amount key ${key} must be a safe integer (cents); floats are forbidden`,
    );
  }
}

/** Validate every entry before write (amount int-only). */
export function validateSettingsEntries(entries: readonly SettingsEntry[]): void {
  for (const entry of entries) {
    parseSettingsValueJson(entry.key, entry.value_json);
  }
}

/**
 * In-memory settings map for unit tests / skeleton runtime.
 * Not a route-facing API — inject into createPlatformHandlers only.
 */
export function createMemorySettingsStore(
  initial?: Readonly<Record<string, string>>,
): SettingsStore {
  const map = new Map<string, string>(Object.entries(initial ?? {}));
  return Object.freeze({
    async getMany(keys: readonly string[]): Promise<Readonly<Record<string, string>>> {
      const out: Record<string, string> = {};
      for (const key of keys) {
        const value = map.get(key);
        if (value !== undefined) out[key] = value;
      }
      return Object.freeze(out);
    },
    async setMany(entries: readonly SettingsEntry[]): Promise<void> {
      validateSettingsEntries(entries);
      for (const entry of entries) {
        map.set(entry.key, entry.value_json);
      }
    },
  });
}

/**
 * SqlClient-backed settings against packages/db `settings` table (org RLS).
 * Must run inside withTenantTransaction so app.org_id GUC is set.
 * Unique key: (org_id, key).
 */
export function createSqlSettingsStore(client: SqlClient, tenant: TenantContext): SettingsStore {
  return Object.freeze({
    async getMany(keys: readonly string[]): Promise<Readonly<Record<string, string>>> {
      if (keys.length === 0) return Object.freeze({});
      const result = await client.query<{ key: string; value_json: string }>(
        `SELECT key, value_json
           FROM settings
          WHERE org_id = $1
            AND key = ANY($2::text[])`,
        [tenant.orgId, keys],
      );
      const out: Record<string, string> = {};
      for (const row of result.rows) {
        out[row.key] = row.value_json;
      }
      return Object.freeze(out);
    },
    async setMany(entries: readonly SettingsEntry[]): Promise<void> {
      validateSettingsEntries(entries);
      for (const entry of entries) {
        await client.query(
          `INSERT INTO settings (
             id, org_id, key, value_json, updated_at, updated_by_staff_id
           ) VALUES ($1, $2, $3, $4, NOW(), $5)
           ON CONFLICT (org_id, key) DO UPDATE SET
             value_json = EXCLUDED.value_json,
             updated_at = EXCLUDED.updated_at,
             updated_by_staff_id = EXCLUDED.updated_by_staff_id`,
          [randomUUID(), tenant.orgId, entry.key, entry.value_json, tenant.staffId],
        );
      }
    },
  });
}
