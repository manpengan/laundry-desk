/**
 * PostgreSQL role names for the formal v2 schema (ADR-02).
 * laundry_app must remain NOBYPASSRLS; laundry_owner owns DDL / maintenance.
 */
export const LAUNDRY_OWNER_ROLE = "laundry_owner" as const;
export const LAUNDRY_APP_ROLE = "laundry_app" as const;

export const DB_ROLES = Object.freeze({
  owner: LAUNDRY_OWNER_ROLE,
  app: LAUNDRY_APP_ROLE,
} as const);

export const PUBLIC_SCHEMA = "public" as const;
