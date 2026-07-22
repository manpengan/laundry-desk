export { orgs } from "./orgs.js";
export { stores } from "./stores.js";
export { staffs } from "./staffs.js";
export { staffStoreRoles } from "./staff-store-roles.js";
export { settings } from "./settings.js";
export { storeFeatures } from "./store-features.js";
export { auditLog } from "./audit-log.js";
export { sessions } from "./sessions.js";
export { refreshFamilies } from "./refresh-families.js";
export { refreshTokens } from "./refresh-tokens.js";
export { pinChallenges } from "./pin-challenges.js";
export { pinLockouts } from "./pin-lockouts.js";
export { orders } from "./orders.js";
export { orderLines } from "./order-lines.js";
export { garments } from "./garments.js";
export { ticketCounters } from "./ticket-counters.js";
export { catalogItems } from "./catalog-items.js";

import { orgs } from "./orgs.js";
import { stores } from "./stores.js";
import { staffs } from "./staffs.js";
import { staffStoreRoles } from "./staff-store-roles.js";
import { settings } from "./settings.js";
import { storeFeatures } from "./store-features.js";
import { auditLog } from "./audit-log.js";
import { sessions } from "./sessions.js";
import { refreshFamilies } from "./refresh-families.js";
import { refreshTokens } from "./refresh-tokens.js";
import { pinChallenges } from "./pin-challenges.js";
import { pinLockouts } from "./pin-lockouts.js";
import { orders } from "./orders.js";
import { orderLines } from "./order-lines.js";
import { garments } from "./garments.js";
import { ticketCounters } from "./ticket-counters.js";
import { catalogItems } from "./catalog-items.js";

/** M1 tables present in the A3 tenant matrix. */
export const M1_MATRIX_TABLES = Object.freeze({
  orgs,
  stores,
  staffs,
  staff_store_roles: staffStoreRoles,
  settings,
  store_features: storeFeatures,
  audit_log: auditLog,
} as const);

/** A5 session infrastructure tables (store-scoped columns; not in A3 matrix). */
export const M1_SESSION_TABLES = Object.freeze({
  sessions,
  refresh_families: refreshFamilies,
  refresh_tokens: refreshTokens,
  pin_challenges: pinChallenges,
  pin_lockouts: pinLockouts,
} as const);

/** M2 order skeleton tables (store-scoped; maps runtime OrderRecord). */
export const M2_ORDER_TABLES = Object.freeze({
  orders,
  order_lines: orderLines,
  garments,
  ticket_counters: ticketCounters,
} as const);

/** M2 catalog tables (store-scoped price list). */
export const M2_CATALOG_TABLES = Object.freeze({
  catalog_items: catalogItems,
} as const);

/** Full M1 identity/platform + M2 schema surface for drizzle-kit and public API. */
export const schema = Object.freeze({
  ...M1_MATRIX_TABLES,
  ...M1_SESSION_TABLES,
  ...M2_ORDER_TABLES,
  ...M2_CATALOG_TABLES,
} as const);

export type M1MatrixTableName = keyof typeof M1_MATRIX_TABLES;
export type M1SessionTableName = keyof typeof M1_SESSION_TABLES;
export type M2OrderTableName = keyof typeof M2_ORDER_TABLES;
export type M2CatalogTableName = keyof typeof M2_CATALOG_TABLES;
export type M1TableName = keyof typeof M1_MATRIX_TABLES | keyof typeof M1_SESSION_TABLES;
export type SchemaTableName = keyof typeof schema;
