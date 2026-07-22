/**
 * Catalog lookup / filter pure helpers (M2 skeleton).
 */

import type { CatalogItem } from "./types.js";

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Find first item whose mnemonic matches (case-insensitive, trimmed).
 * Returns undefined when mnemonic is empty or no match.
 */
export function lookupByMnemonic(
  items: readonly CatalogItem[],
  mnemonic: string,
): CatalogItem | undefined {
  const key = normalizeKey(mnemonic);
  if (key.length === 0) return undefined;
  return items.find((item) => {
    if (item.mnemonic === undefined) return false;
    return normalizeKey(item.mnemonic) === key;
  });
}

/**
 * Simple substring filter over code / name / mnemonic / service / category.
 * Empty or whitespace-only query returns a shallow copy of all items.
 */
export function filterCatalog(items: readonly CatalogItem[], query: string): CatalogItem[] {
  const key = normalizeKey(query);
  if (key.length === 0) {
    return items.slice();
  }
  return items.filter((item) => {
    if (normalizeKey(item.code).includes(key)) return true;
    if (normalizeKey(item.name).includes(key)) return true;
    if (normalizeKey(item.service_code).includes(key)) return true;
    if (normalizeKey(item.category_code).includes(key)) return true;
    if (item.mnemonic !== undefined && normalizeKey(item.mnemonic).includes(key)) return true;
    return false;
  });
}

/** Exact code match (case-sensitive ASCII codes). */
export function findByCode(items: readonly CatalogItem[], code: string): CatalogItem | undefined {
  if (code.length === 0) return undefined;
  return items.find((item) => item.code === code);
}
