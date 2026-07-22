/**
 * Canonical M1 identity/platform table names.
 * Matrix subset follows A3; session tables support A5 without inventing matrix entries.
 */

export const M1_MATRIX_TABLE_NAMES = Object.freeze([
  "orgs",
  "stores",
  "staffs",
  "staff_store_roles",
  "settings",
  "store_features",
  "audit_log",
] as const);

export const M1_SESSION_TABLE_NAMES = Object.freeze([
  "sessions",
  "refresh_families",
  "refresh_tokens",
  "pin_challenges",
  "pin_lockouts",
] as const);

export const M1_ALL_TABLE_NAMES = Object.freeze([
  ...M1_MATRIX_TABLE_NAMES,
  ...M1_SESSION_TABLE_NAMES,
] as const);

/** Tables deferred past M1 identity/platform + M2 order/catalog/payments/print skeleton (edge / AI). */
export const DEFERRED_V2_TABLES_NOTE = Object.freeze({
  reason:
    "packages/db ships identity/platform + A5 session + M2 order/catalog/payments/print skeleton; remaining A3 matrix tables land with later domain packages.",
  deferredExamples: Object.freeze([
    "customers",
    "devices",
    "edge_devices",
    "primary_lease_heads",
    "primary_leases",
    "ticket_no_blocks",
    "ai_pending_actions",
    "ai_model_registry",
  ] as const),
} as const);

export type M1MatrixTableNameLiteral = (typeof M1_MATRIX_TABLE_NAMES)[number];
export type M1SessionTableNameLiteral = (typeof M1_SESSION_TABLE_NAMES)[number];
