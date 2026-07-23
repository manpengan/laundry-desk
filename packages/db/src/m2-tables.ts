/**
 * Canonical M2 + M3 table names (order + catalog + payments + print + customers +
 * shift + garment_photos). Aligns with runtime OrderRecord / CatalogItem /
 * PaymentRow / PrintJobRecord / CustomerRecord / ShiftClosingRecord / PhotoRecord.
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

export const M2_CUSTOMER_TABLE_NAMES = Object.freeze(["customers"] as const);

export const M2_SHIFT_TABLE_NAMES = Object.freeze(["shift_closings"] as const);

export const M3_PHOTO_TABLE_NAMES = Object.freeze(["garment_photos"] as const);

export const M2_ALL_TABLE_NAMES = Object.freeze([
  ...M2_ORDER_TABLE_NAMES,
  ...M2_CATALOG_TABLE_NAMES,
  ...M2_PAYMENT_TABLE_NAMES,
  ...M2_PRINT_TABLE_NAMES,
  ...M2_CUSTOMER_TABLE_NAMES,
  ...M2_SHIFT_TABLE_NAMES,
  ...M3_PHOTO_TABLE_NAMES,
] as const);

export type M2OrderTableNameLiteral = (typeof M2_ORDER_TABLE_NAMES)[number];
export type M2CatalogTableNameLiteral = (typeof M2_CATALOG_TABLE_NAMES)[number];
export type M2PaymentTableNameLiteral = (typeof M2_PAYMENT_TABLE_NAMES)[number];
export type M2PrintTableNameLiteral = (typeof M2_PRINT_TABLE_NAMES)[number];
export type M2CustomerTableNameLiteral = (typeof M2_CUSTOMER_TABLE_NAMES)[number];
export type M2ShiftTableNameLiteral = (typeof M2_SHIFT_TABLE_NAMES)[number];
export type M3PhotoTableNameLiteral = (typeof M3_PHOTO_TABLE_NAMES)[number];
export type M2TableNameLiteral = (typeof M2_ALL_TABLE_NAMES)[number];
