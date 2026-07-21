/**
 * Route gate pure helpers (E3).
 * UI gate only; C8 enforces server-side authorization.
 */

import type { PermissionContext } from "../auth/permissions.js";
import { defaultAllowedNavId, filterNavItems, isNavAllowed } from "../auth/permissions.js";
import type { NavItem, NavItemId } from "../nav.js";

export type RouteGateDecision =
  | Readonly<{ status: "allow"; navId: NavItemId }>
  | Readonly<{ status: "deny"; navId: NavItemId; fallbackId: NavItemId }>;

export type DeniedPageCopy = Readonly<{
  title: string;
  description: string;
  actionLabel: string;
}>;

/** Unauthorized empty-state copy (no crash). */
export const DENIED_PAGE_COPY: DeniedPageCopy = Object.freeze({
  title: "无权限",
  description: "当前账号无权访问此页面。如需开通请联系店长或管理员。",
  actionLabel: "返回可用页面",
});

export function resolveRouteGate(ctx: PermissionContext, navId: NavItemId): RouteGateDecision {
  if (isNavAllowed(ctx, navId)) {
    return Object.freeze({ status: "allow" as const, navId });
  }
  return Object.freeze({
    status: "deny" as const,
    navId,
    fallbackId: defaultAllowedNavId(ctx),
  });
}

export function visibleNavItems(ctx: PermissionContext): readonly NavItem[] {
  return filterNavItems(ctx);
}

export function canOpenRoute(ctx: PermissionContext, navId: NavItemId): boolean {
  return isNavAllowed(ctx, navId);
}
