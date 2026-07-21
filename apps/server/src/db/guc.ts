import type { TenantContext, Uuid } from "./types.js";

/**
 * Stable GUC names matched by contracts RLS predicates
 * (`NULLIF(current_setting('app.org_id', true), '')::uuid`, etc.).
 * Names are allowlisted constants — never built from user input.
 */
export const TENANT_GUC_KEYS = Object.freeze({
  orgId: "app.org_id",
  storeId: "app.store_id",
  staffId: "app.staff_id",
} as const);

export type TenantGucKey = (typeof TENANT_GUC_KEYS)[keyof typeof TENANT_GUC_KEYS];

/**
 * Parameterized set_config statement.
 * `is_local = true` mirrors `SET LOCAL` so values vanish on COMMIT/ROLLBACK
 * (pool reuse must not leak tenant context — M0-1 five bypass classes).
 */
export type SetLocalGucStatement = Readonly<{
  key: TenantGucKey;
  /** SQL with `$1` for the UUID value; GUC name is a literal constant. */
  sql: string;
  values: readonly [Uuid];
}>;

/** RFC 4122 variant 1 UUID (hex, case-insensitive). Fail closed on anything else. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TENANT_CONTEXT_KEYS = ["orgId", "storeId", "staffId"] as const;

export class TenantGucError extends Error {
  readonly code = "TENANT_GUC_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "TenantGucError";
  }
}

export const isUuid = (value: unknown): value is Uuid =>
  typeof value === "string" && UUID_RE.test(value);

const requireUuid = (value: unknown, field: string): Uuid => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TenantGucError(`TenantContext.${field} is required`);
  }
  if (!isUuid(value)) {
    throw new TenantGucError(`TenantContext.${field} must be a valid UUID`);
  }
  return value.toLowerCase();
};

/**
 * Fail-closed parse of tenant context.
 * Rejects missing fields, empty strings, non-UUID values, and extra shapes.
 */
export const parseTenantContext = (input: unknown): TenantContext => {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TenantGucError("TenantContext must be a plain object");
  }

  const record = input as Record<string, unknown>;
  for (const key of TENANT_CONTEXT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new TenantGucError(`TenantContext.${key} is required`);
    }
  }

  return Object.freeze({
    orgId: requireUuid(record.orgId, "orgId"),
    storeId: requireUuid(record.storeId, "storeId"),
    staffId: requireUuid(record.staffId, "staffId"),
  });
};

/**
 * Build ordered, parameterized GUC injection statements.
 * Order is stable and intentional: org → store → staff (matches ADR-02 session vars).
 *
 * Uses `set_config(name, value, is_local := true)` so the value is a bind parameter
 * and never string-interpolated into SQL. GUC names are fixed literals from the allowlist.
 */
export const buildSetLocalGucStatements = (ctxInput: unknown): readonly SetLocalGucStatement[] => {
  const ctx = parseTenantContext(ctxInput);

  const ordered = [
    [TENANT_GUC_KEYS.orgId, ctx.orgId],
    [TENANT_GUC_KEYS.storeId, ctx.storeId],
    [TENANT_GUC_KEYS.staffId, ctx.staffId],
  ] as const;

  return Object.freeze(
    ordered.map(([key, value]) =>
      Object.freeze({
        key,
        // name is a compile-time allowlisted literal; only the UUID is parameterized.
        sql: `SELECT set_config('${key}', $1, true)`,
        values: Object.freeze([value]) as readonly [Uuid],
      }),
    ),
  );
};
