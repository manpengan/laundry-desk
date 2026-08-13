/** Counter price-list row (integer fen). Mirrors domain CatalogItem. */
export type CatalogListItem = Readonly<{
  code: string;
  name: string;
  service_code: string;
  category_code: string;
  unit_price_cents: number;
  mnemonic?: string;
}>;

export type CatalogListResult = Readonly<{
  items: readonly CatalogListItem[];
  total: number;
}>;

/** Demo seed aligned with apps/server memory catalog (no packages/* import). */
export const DEMO_CATALOG_ITEMS: readonly CatalogListItem[] = Object.freeze([
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

function matchesCatalog(item: CatalogListItem, key: string): boolean {
  if (item.code.toLowerCase().includes(key)) return true;
  if (item.name.toLowerCase().includes(key)) return true;
  if (item.service_code.toLowerCase().includes(key)) return true;
  if (item.category_code.toLowerCase().includes(key)) return true;
  return item.mnemonic !== undefined && item.mnemonic.toLowerCase().includes(key);
}

export function filterDemoCatalog(query: string, limit: number): CatalogListResult {
  const key = query.trim().toLowerCase();
  const filtered =
    key.length === 0
      ? DEMO_CATALOG_ITEMS.slice()
      : DEMO_CATALOG_ITEMS.filter((item) => matchesCatalog(item, key));
  return Object.freeze({
    items: Object.freeze(filtered.slice(0, Math.max(1, limit))),
    total: filtered.length,
  });
}
