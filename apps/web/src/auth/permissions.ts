/**
 * Client-side permission projection for IA / route gates (UI spec §2).
 *
 * UI gate only; C8 enforces server-side authorization. Never treat these
 * checks as a security boundary — they only shape nav chrome and empty states.
 */

import { COUNTER_NAV, type NavItem, type NavItemId } from "../nav.js";

/** Counter roles projected from staff_store_roles (seed/mock). */
export type StaffRole = "admin" | "staff";

/**
 * store_features-like flags (architecture §3.3 / store_features table).
 * Keys are UI projection names; server may use shorter column names.
 */
export const STORE_FEATURE_KEYS = [
  "ai_enabled",
  "member_enabled",
  "fulfillment_enabled",
  "shift_closing_enabled",
  "delivery_enabled",
  "marketing_enabled",
] as const;

export type StoreFeatureKey = (typeof STORE_FEATURE_KEYS)[number];

export type StoreFeatureFlags = Readonly<Record<StoreFeatureKey, boolean>>;

export type PermissionContext = Readonly<{
  role: StaffRole;
  features: Readonly<Record<string, boolean>>;
}>;

/** Access rule for a nav key / route id. */
export type NavAccessRule = Readonly<{
  /** If set, role must be included. Omit = any authenticated role. */
  roles?: readonly StaffRole[];
  /** Every listed feature key must be truthy on the session projection. */
  features?: readonly string[];
}>;

/**
 * Nav → required permission (M1 counter IA subset).
 * admin: full chrome; staff: day-to-day counter only (no stats/settings).
 * Feature keys reserved for optional IA (production, AI drawer sections, etc.).
 */
export const NAV_ACCESS_RULES: Readonly<Record<NavItemId, NavAccessRule>> = Object.freeze({
  workbench: Object.freeze({}),
  receive: Object.freeze({}),
  pickup: Object.freeze({}),
  customers: Object.freeze({}),
  stats: Object.freeze({ roles: Object.freeze(["admin"] as const) }),
  settings: Object.freeze({ roles: Object.freeze(["admin"] as const) }),
});

export const FULL_STORE_FEATURES: StoreFeatureFlags = Object.freeze({
  ai_enabled: true,
  member_enabled: true,
  fulfillment_enabled: true,
  shift_closing_enabled: true,
  delivery_enabled: true,
  marketing_enabled: true,
});

/** Staff mock projection: core counter on; AI / advanced modules off. */
export const STAFF_STORE_FEATURES: StoreFeatureFlags = Object.freeze({
  ai_enabled: false,
  member_enabled: true,
  fulfillment_enabled: false,
  shift_closing_enabled: false,
  delivery_enabled: false,
  marketing_enabled: false,
});

export function hasFeature(features: Readonly<Record<string, boolean>>, key: string): boolean {
  return features[key] === true;
}

export function isNavAllowed(ctx: PermissionContext, id: NavItemId): boolean {
  return isRuleSatisfied(ctx, NAV_ACCESS_RULES[id]);
}

export function isRuleSatisfied(ctx: PermissionContext, rule: NavAccessRule): boolean {
  if (rule.roles !== undefined && rule.roles.length > 0) {
    if (!rule.roles.includes(ctx.role)) return false;
  }
  if (rule.features !== undefined) {
    for (const key of rule.features) {
      if (!hasFeature(ctx.features, key)) return false;
    }
  }
  return true;
}

/** Allowed nav keys for the current role × features projection. */
export function allowedNavKeys(ctx: PermissionContext): readonly NavItemId[] {
  return COUNTER_NAV.filter((item) => isNavAllowed(ctx, item.id)).map((item) => item.id);
}

/** Sidebar items filtered by permission projection. */
export function filterNavItems(
  ctx: PermissionContext,
  items: readonly NavItem[] = COUNTER_NAV,
): readonly NavItem[] {
  return items.filter((item) => isNavAllowed(ctx, item.id));
}

/** First allowed nav key (fallback workbench if somehow empty). */
export function defaultAllowedNavId(ctx: PermissionContext): NavItemId {
  const keys = allowedNavKeys(ctx);
  return keys[0] ?? "workbench";
}

export function permissionContextFrom(
  role: StaffRole,
  features: Readonly<Record<string, boolean>>,
): PermissionContext {
  return Object.freeze({ role, features });
}
