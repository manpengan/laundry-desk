import { EmptyState } from "@laundry/ui";
import type { ReactNode } from "react";
import type { PermissionContext } from "../auth/permissions.js";
import type { NavItemId } from "../nav.js";
import { DENIED_PAGE_COPY, resolveRouteGate } from "./route-gate.js";

export type RouteGateProps = {
  permission: PermissionContext;
  activeId: NavItemId;
  onNavigate: (id: NavItemId) => void;
  children: ReactNode;
};

/**
 * Renders children when the active route is allowed for role × features;
 * otherwise an EmptyState「无权限」shell (never throws).
 *
 * UI gate only; C8 enforces server-side authorization.
 */
export function RouteGate({ permission, activeId, onNavigate, children }: RouteGateProps) {
  const decision = resolveRouteGate(permission, activeId);

  if (decision.status === "deny") {
    return (
      <main
        className="ld-shell-main lg-card"
        id="main-content"
        tabIndex={-1}
        data-route-gate="denied"
        data-denied-nav={decision.navId}
      >
        <EmptyState
          title={DENIED_PAGE_COPY.title}
          description={DENIED_PAGE_COPY.description}
          actionLabel={DENIED_PAGE_COPY.actionLabel}
          onAction={() => onNavigate(decision.fallbackId)}
        />
      </main>
    );
  }

  return <>{children}</>;
}
