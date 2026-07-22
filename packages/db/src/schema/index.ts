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

/** Full M1 identity/platform schema surface for drizzle-kit and public API. */
export const schema = Object.freeze({
  ...M1_MATRIX_TABLES,
  ...M1_SESSION_TABLES,
} as const);

export type M1MatrixTableName = keyof typeof M1_MATRIX_TABLES;
export type M1SessionTableName = keyof typeof M1_SESSION_TABLES;
export type M1TableName = keyof typeof schema;
