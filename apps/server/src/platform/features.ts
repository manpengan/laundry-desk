/**
 * C7 store_features flags (architecture §4 / store_features table).
 * Read path for IA and capability gates; inject store via handlers only.
 */

import type { SqlClient } from "../db/types.js";

/** Stable M1 feature flag set (boolean only). */
export type StoreFeatureFlags = Readonly<{
  fulfillment: boolean;
  membership: boolean;
  shift_closing: boolean;
  delivery: boolean;
  marketing: boolean;
  ai: boolean;
}>;

export const DEFAULT_STORE_FEATURES: StoreFeatureFlags = Object.freeze({
  fulfillment: true,
  membership: false,
  shift_closing: false,
  delivery: false,
  marketing: false,
  ai: false,
});

export type FeaturesStore = Readonly<{
  get: (storeId: string) => Promise<StoreFeatureFlags>;
  /** Test/seed helper — not a bus command in M1 A6 catalog. */
  put?: (storeId: string, flags: StoreFeatureFlags) => Promise<void>;
}>;

function normalizeFlags(partial: Partial<StoreFeatureFlags> | undefined): StoreFeatureFlags {
  return Object.freeze({
    fulfillment: partial?.fulfillment ?? DEFAULT_STORE_FEATURES.fulfillment,
    membership: partial?.membership ?? DEFAULT_STORE_FEATURES.membership,
    shift_closing: partial?.shift_closing ?? DEFAULT_STORE_FEATURES.shift_closing,
    delivery: partial?.delivery ?? DEFAULT_STORE_FEATURES.delivery,
    marketing: partial?.marketing ?? DEFAULT_STORE_FEATURES.marketing,
    ai: partial?.ai ?? DEFAULT_STORE_FEATURES.ai,
  });
}

/** In-memory store_features map keyed by store_id. */
export function createMemoryFeaturesStore(
  initial?: Readonly<Record<string, Partial<StoreFeatureFlags>>>,
): FeaturesStore {
  const map = new Map<string, StoreFeatureFlags>();
  for (const [storeId, flags] of Object.entries(initial ?? {})) {
    map.set(storeId, normalizeFlags(flags));
  }
  return Object.freeze({
    async get(storeId: string): Promise<StoreFeatureFlags> {
      return map.get(storeId) ?? DEFAULT_STORE_FEATURES;
    },
    async put(storeId: string, flags: StoreFeatureFlags): Promise<void> {
      map.set(storeId, normalizeFlags(flags));
    },
  });
}

/** SqlClient skeleton — SELECT fixed columns; empty row → defaults. */
export function createSqlFeaturesStore(client: SqlClient): FeaturesStore {
  return Object.freeze({
    async get(storeId: string): Promise<StoreFeatureFlags> {
      const result = await client.query<{
        fulfillment: boolean;
        membership: boolean;
        shift_closing: boolean;
        delivery: boolean;
        marketing: boolean;
        ai: boolean;
      }>(
        `SELECT fulfillment, membership, shift_closing, delivery, marketing, ai
         FROM store_features WHERE store_id = $1 LIMIT 1`,
        [storeId],
      );
      const row = result.rows[0];
      if (row === undefined) return DEFAULT_STORE_FEATURES;
      return normalizeFlags(row);
    },
  });
}
