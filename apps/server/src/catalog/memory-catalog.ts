/**
 * In-memory demo price list (M2 skeleton). No PG tables yet.
 * Web / receive UI can list these via catalog.items.list.
 */

import type { CatalogItem } from "@laundry/domain";

/** Seed codes + integer fen prices for local/demo counter. */
export const DEMO_CATALOG_ITEMS: readonly CatalogItem[] = Object.freeze([
  Object.freeze({
    code: "wash_shirt",
    name: "水洗衬衫",
    service_code: "wash",
    category_code: "shirt",
    unit_price_cents: 1500,
    mnemonic: "xs",
  }),
  Object.freeze({
    code: "wash_pants",
    name: "水洗西裤",
    service_code: "wash",
    category_code: "pants",
    unit_price_cents: 1800,
    mnemonic: "xk",
  }),
  Object.freeze({
    code: "dry_coat",
    name: "干洗大衣",
    service_code: "dry",
    category_code: "coat",
    unit_price_cents: 4500,
    mnemonic: "dy",
  }),
  Object.freeze({
    code: "dry_suit",
    name: "干洗西装",
    service_code: "dry",
    category_code: "suit",
    unit_price_cents: 3800,
    mnemonic: "xz",
  }),
  Object.freeze({
    code: "iron_shirt",
    name: "熨烫衬衫",
    service_code: "iron",
    category_code: "shirt",
    unit_price_cents: 800,
    mnemonic: "yt",
  }),
  Object.freeze({
    code: "wash_duvet",
    name: "水洗被套",
    service_code: "wash",
    category_code: "duvet",
    unit_price_cents: 3500,
    mnemonic: "bt",
  }),
]);

export type CatalogStore = Readonly<{
  listAll: () => readonly CatalogItem[];
}>;

/** Closed-over seed list (immutable). */
export function createMemoryCatalogStore(
  items: readonly CatalogItem[] = DEMO_CATALOG_ITEMS,
): CatalogStore {
  const snapshot = Object.freeze(items.map((item) => Object.freeze({ ...item })));
  return Object.freeze({
    listAll(): readonly CatalogItem[] {
      return snapshot;
    },
  });
}
