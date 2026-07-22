/**
 * Catalog pricing pure helpers — integer cents only.
 */

import { validateCents } from "../money.js";
import type { CatalogItem } from "./types.js";

/**
 * Line total = unit_price_cents × qty.
 * Both operands must be non-negative integers; qty ≥ 1.
 */
export function resolveLinePrice(item: Pick<CatalogItem, "unit_price_cents">, qty: number): number {
  validateCents(item.unit_price_cents);
  if (!Number.isInteger(qty) || qty < 1) {
    throw new TypeError(`qty must be a positive integer, got: ${qty}`);
  }
  if (item.unit_price_cents < 0) {
    throw new TypeError(`unit_price_cents must be non-negative, got: ${item.unit_price_cents}`);
  }
  return item.unit_price_cents * qty;
}
