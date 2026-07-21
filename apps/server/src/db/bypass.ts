/**
 * Explicit RLS / privileged-path bypass classes.
 *
 * Default deny: laundry_app is NOBYPASSRLS and always runs with tenant GUCs.
 * Only the closed set below may leave the tenant-GUC path, and every grant
 * requires a non-empty reason string for audit (stub sink until C3 audit lands).
 *
 * These are *allowed* operational classes — distinct from the five M0-1
 * negative "bypass" attack cases (unset GUC / empty / rollback residue /
 * pool cross-tenant / worker missing injection), which must never be granted.
 */

export const RLS_BYPASS_CLASSES = Object.freeze([
  /** Schema migrations under laundry_owner (not laundry_app). */
  "migration_owner",
  /** Operational maintenance under laundry_owner + maintenance_policy. */
  "maintenance",
  /** Read global-scope tables with no tenant GUC policy (orgs, ai_model_registry). */
  "platform_global_read",
  /** Platform registry writes (global dictionaries) under controlled admin path. */
  "platform_global_write",
  /** Break-glass support access; every use must be human-reasoned and audited. */
  "support_break_glass",
] as const);

export type RlsBypassClass = (typeof RLS_BYPASS_CLASSES)[number];

export type BypassAuditEvent = Readonly<{
  kind: "rls_bypass_granted";
  bypassClass: RlsBypassClass;
  reason: string;
  at: string;
}>;

export type BypassAuditSink = (event: BypassAuditEvent) => void | Promise<void>;

export type RlsBypassGrant = Readonly<{
  bypassClass: RlsBypassClass;
  reason: string;
}>;

export type RequestBypassInput = Readonly<{
  bypassClass: string;
  reason: string;
}>;

export class RlsBypassError extends Error {
  readonly code = "RLS_BYPASS_DENIED" as const;

  constructor(message: string) {
    super(message);
    this.name = "RlsBypassError";
  }
}

const ALLOWED = new Set<string>(RLS_BYPASS_CLASSES);

export const isRlsBypassClass = (value: unknown): value is RlsBypassClass =>
  typeof value === "string" && ALLOWED.has(value);

const normalizeReason = (reason: unknown): string => {
  if (typeof reason !== "string") {
    throw new RlsBypassError("Bypass reason must be a non-empty string");
  }
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw new RlsBypassError("Bypass reason is required");
  }
  return trimmed;
};

/**
 * Default-deny gate for privileged DB paths.
 * Rejects unknown classes and empty reasons before any connection is used.
 */
export async function requestRlsBypass(
  input: RequestBypassInput,
  audit: BypassAuditSink = noopBypassAudit,
): Promise<RlsBypassGrant> {
  if (!isRlsBypassClass(input.bypassClass)) {
    throw new RlsBypassError(
      `RLS bypass class "${String(input.bypassClass)}" is not allowed (default deny)`,
    );
  }
  const reason = normalizeReason(input.reason);
  const grant = Object.freeze({
    bypassClass: input.bypassClass,
    reason,
  });

  await audit(
    Object.freeze({
      kind: "rls_bypass_granted",
      bypassClass: grant.bypassClass,
      reason: grant.reason,
      at: new Date().toISOString(),
    }),
  );

  return grant;
}

/** Stub audit sink — replace with C3 audit_log INSERT in the same bus transaction. */
export const noopBypassAudit: BypassAuditSink = (): void => {
  // intentionally empty until C3 wires real audit
};
