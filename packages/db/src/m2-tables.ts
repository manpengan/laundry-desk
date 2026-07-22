/**
 * Canonical M2 table names (order skeleton + catalog + payments + print jobs).
 * Aligns with runtime OrderRecord / CatalogItem / PaymentRow / PrintJobRecord and ADR-03 composite keys.
 */

export const M2_ORDER_TABLE_NAMES = Object.freeze([
  "orders",
  "order_lines",
  "garments",
  "ticket_counters",
] as const);

export const M2_CATALOG_TABLE_NAMES = Object.freeze(["catalog_items"] as const);

export const M2_PAYMENT_TABLE_NAMES = Object.freeze(["payments"] as const);

export const M2_PRINT_TABLE_NAMES = Object.freeze(["print_jobs"] as const);

export const M2_ALL_TABLE_NAMES = Object.freeze([
  ...M2_ORDER_TABLE_NAMES,
  ...M2_CATALOG_TABLE_NAMES,
  ...M2_PAYMENT_TABLE_NAMES,
  ...M2_PRINT_TABLE_NAMES,
] as const);

export type M2OrderTableNameLiteral = (typeof M2_ORDER_TABLE_NAMES)[number];
export type M2CatalogTableNameLiteral = (typeof M2_CATALOG_TABLE_NAMES)[number];
export type M2PaymentTableNameLiteral = (typeof M2_PAYMENT_TABLE_NAMES)[number];
export type M2PrintTableNameLiteral = (typeof M2_PRINT_TABLE_NAMES)[number];
export type M2TableNameLiteral = (typeof M2_ALL_TABLE_NAMES)[number];
