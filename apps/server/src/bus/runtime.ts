import type { SessionStaffAuthority } from "../auth/session-view.js";
import type { LocalRuntime } from "../local/demo-seed.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";

const ADMIN_PERMISSIONS = Object.freeze([
  "settings_admin",
  "staff_read",
  "staff_write",
  "customer_read",
  "customer_write",
  "order_write",
  "accounting_read",
  "ledger_export",
  "payment_refund",
  "shift_close",
  "print_manage",
  "audit_read",
  "edge_conflict_resolve",
  // ADR-22 §2.3: changing a top-up bonus tier changes how much money the shop
  // gives away, so it is admin-only and deliberately not bundled with pricing.
  "member_rule_write",
  // ADR-22 §5: R4 money-out. Separate from payment_refund because that returns
  // an order payment, while this returns prepaid money held for the customer.
  "member_refund",
  "member_freeze",
  // ADR-25: unfreeze and terminal closure change access to customer value.
  "member_lifecycle_manage",
]);
const STAFF_PERMISSIONS = Object.freeze([
  "staff_read",
  "customer_read",
  "customer_write",
  "order_write",
  // A counter worker may immediately protect a reported-lost account; restoring
  // or closing it remains admin-only.
  "member_freeze",
]);
const NO_PERMISSIONS = Object.freeze([] as string[]);

export function permissionsForAuthority(
  authority: Pick<SessionStaffAuthority, "role" | "is_privacy_admin">,
): readonly string[] {
  if (authority.role === "admin") {
    return Object.freeze([
      ...ADMIN_PERMISSIONS,
      ...(authority.is_privacy_admin ? ["privacy_admin"] : []),
    ]);
  }
  return authority.role === "staff" ? STAFF_PERMISSIONS : NO_PERMISSIONS;
}

export function createRuntimeBus(runtime: LocalRuntime) {
  return createRegisteredM1Bus(
    {
      identity: runtime.identity,
      platform: runtime.platform,
      order: runtime.order,
      catalog: runtime.catalog,
      print: runtime.print,
      stats: runtime.stats,
      customer: runtime.customer,
      shift: runtime.shift,
      reconciliation: runtime.reconciliation,
      accounting: runtime.accounting,
      reporting: runtime.reporting,
      photo: runtime.photo,
      fulfillment: runtime.fulfillment,
      staffAccess: runtime.staffAccess,
      member: runtime.member,
      notification: runtime.notification,
    },
    runtime.pendingStore,
  );
}
