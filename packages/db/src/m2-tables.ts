/**
 * Canonical M2 order-skeleton table names.
 * Aligns with runtime OrderRecord / GarmentRecord and ADR-03 composite keys.
 */

export const M2_ORDER_TABLE_NAMES = Object.freeze([
  "orders",
  "order_lines",
  "garments",
  "ticket_counters",
] as const);

export type M2OrderTableNameLiteral = (typeof M2_ORDER_TABLE_NAMES)[number];
