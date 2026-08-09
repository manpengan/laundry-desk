/**
 * M1 handler registration — loads A6 command/query definitions and attaches handlers.
 * Optional M2 order/catalog/print/stats/customer/shift + M3 photo when deps provided.
 */

import type { ChainPortHooks } from "../bus/chain-adapter.js";
import type { AccountingHandlerDeps } from "../accounting/types.js";
import { createAccountingHandlers } from "../accounting/handlers.js";
import { createM1CommandRegistry, type MutableCommandRegistry } from "../bus/registry.js";
import { createM1QueryRegistry, type MutableQueryRegistry } from "../bus/query-registry.js";
import type { CatalogHandlerDeps } from "../catalog/handlers.js";
import {
  registerCatalogCommandHandlers,
  registerCatalogQueryHandlers,
} from "../catalog/handlers.js";
import type { CustomerHandlerDeps } from "../customer/handlers.js";
import {
  registerCustomerCommandHandlers,
  registerCustomerQueryHandlers,
} from "../customer/handlers.js";
import type { OrderHandlerDeps } from "../order/handlers.js";
import { registerOrderCommandHandlers, registerOrderQueryHandlers } from "../order/handlers.js";
import type { FulfillmentHandlerDeps } from "../fulfillment/handlers.js";
import {
  registerFulfillmentCommandHandlers,
  registerFulfillmentQueryHandlers,
} from "../fulfillment/handlers.js";
import { registerOrderWorkdayCommandHandlers } from "../order/workday-handlers.js";
import { registerPaymentCommandHandlers } from "../payment/handlers.js";
import type { PhotoHandlerDeps } from "../photo/handlers.js";
import { registerPhotoCommandHandlers, registerPhotoQueryHandlers } from "../photo/handlers.js";
import type { PrintHandlerDeps } from "../print/handlers.js";
import { registerPrintCommandHandlers, registerPrintQueryHandlers } from "../print/handlers.js";
import type { ReconciliationHandlerDeps } from "../reconciliation/types.js";
import {
  registerReconciliationCommandHandlers,
  registerReconciliationQueryHandlers,
} from "../reconciliation/handlers.js";
import type { ReportingHandlerDeps } from "../reporting/types.js";
import { registerReportingQueryHandlers } from "../reporting/handlers.js";
import type { ShiftHandlerDeps } from "../shift/handlers.js";
import { registerShiftCommandHandlers, registerShiftQueryHandlers } from "../shift/handlers.js";
import type { StatsHandlerDeps } from "../stats/handlers.js";
import { registerStatsQueryHandlers } from "../stats/handlers.js";
import type { MemberRuntimeDeps } from "../member/handlers.js";
import { createMemberHandlers } from "../member/handlers.js";
import { createMemberTopupConfirmationPreparer } from "../member/topup-confirmation.js";
import type { NotificationHandlerDeps } from "../notification/types.js";
import { processPendingActionStore } from "../pending-actions/process-store.js";
import type { PendingActionStore } from "../pending-actions/types.js";
import { createNotificationHandlers } from "../notification/handlers.js";
import type { StaffAccessHandlerDeps } from "../staff/handlers.js";
import { createStaffAccessHandlers } from "../staff/handlers.js";
import type { IdentityHandlerDeps } from "./identity-handlers.js";
import { registerIdentityCommandHandlers } from "./identity-handlers.js";
import type { PlatformHandlerDeps } from "./platform-handlers.js";
import { registerPlatformHandlers, registerPlatformQueryHandlers } from "./platform-handlers.js";
import { createDefaultChainHooks } from "./default-chain-hooks.js";

export type RegisterM1Deps = Readonly<{
  identity?: IdentityHandlerDeps;
  platform?: PlatformHandlerDeps;
  /** M2 skeleton order receive/pickup/get (memory or PG store). */
  order?: OrderHandlerDeps;
  /** M2 catalog price list (memory or PG). */
  catalog?: CatalogHandlerDeps;
  /** M2 print ticket job queue (memory or PG). */
  print?: PrintHandlerDeps;
  /** M2 day stats (order-backed or seeded). */
  stats?: StatsHandlerDeps;
  /** M2 customer archive (memory or PG). */
  customer?: CustomerHandlerDeps;
  /** M2 shift closing / 日结签字 (memory). */
  shift?: ShiftHandlerDeps;
  /** Store-day accounting reconciliation, audited export and Edge conflict resolution. */
  reconciliation?: ReconciliationHandlerDeps;
  /** ADR-24 dual-basis day/month/staff accounting reports. */
  accounting?: AccountingHandlerDeps;
  /** ADR-26 owner dashboard; financial rows reuse the ADR-24 read port. */
  reporting?: ReportingHandlerDeps;
  /** M3 garment photo metadata (memory). */
  photo?: PhotoHandlerDeps;
  /** M3 garment production, incidents and loss handling. */
  fulfillment?: FulfillmentHandlerDeps;
  staffAccess?: StaffAccessHandlerDeps;
  member?: MemberRuntimeDeps;
  /** ADR-23 manual pickup-reminder worklist and append-only generation log. */
  notification?: NotificationHandlerDeps;
}>;

export type RegisterM1Result = Readonly<{
  registry: MutableCommandRegistry;
  queryRegistry: MutableQueryRegistry;
  chainHooks: ChainPortHooks;
  registered: readonly string[];
  registeredQueries: readonly string[];
}>;

/**
 * Create an M1 registry, attach available identity/platform handlers, and
 * return default chain hooks (parse via definition Zod; policy via C5).
 */
export function registerM1Handlers(
  registry: MutableCommandRegistry,
  deps: RegisterM1Deps,
): readonly string[] {
  const registered: string[] = [];

  if (deps.identity !== undefined) {
    registerIdentityCommandHandlers(registry, deps.identity);
    registered.push(
      "identity.login",
      "identity.refresh",
      "identity.logout",
      "identity.pin_challenge",
      "identity.pin_verify",
    );
  }

  if (deps.platform !== undefined) {
    registerPlatformHandlers(registry, deps.platform);
    registered.push("platform.settings.set");
  }

  // ADR-15: price maintenance is a command; the query side stays read-only.
  if (deps.catalog !== undefined) {
    registerCatalogCommandHandlers(registry, deps.catalog);
    registered.push("catalog.item.upsert");
  }

  if (deps.order !== undefined) {
    registerOrderCommandHandlers(registry, deps.order);
    registerOrderWorkdayCommandHandlers(registry, deps.order);
    registerPaymentCommandHandlers(registry, deps.order);
    registered.push(
      "order.receive",
      "order.hold",
      "order.cancel",
      "order.pickup",
      "payment.collect",
      "payment.repay",
      "payment.refund",
    );
  }

  if (deps.print !== undefined) {
    registerPrintCommandHandlers(registry, deps.print);
    registered.push(
      "print.ticket.enqueue",
      "print.ticket.process",
      "print.ticket.retry",
      "print.ticket.reprint",
    );
  }

  if (deps.customer !== undefined) {
    registerCustomerCommandHandlers(registry, deps.customer);
    registered.push(
      "customer.upsert",
      "customer.update",
      "customer.merge",
      "customer.privacy.export",
      "customer.anonymize",
    );
  }

  if (deps.shift !== undefined) {
    registerShiftCommandHandlers(registry, deps.shift);
    registered.push("shift.close");
  }

  if (deps.reconciliation !== undefined) {
    registerReconciliationCommandHandlers(registry, deps.reconciliation);
    registered.push("reconciliation.export", "edge.conflict.discard");
  }

  if (deps.accounting !== undefined) {
    const handlers = createAccountingHandlers(deps.accounting);
    registry.registerHandler("accounting.report.export", handlers["accounting.report.export"]);
    registered.push("accounting.report.export");
  }

  if (deps.photo !== undefined) {
    registerPhotoCommandHandlers(registry, deps.photo);
    registered.push("photo.register");
  }

  if (deps.fulfillment !== undefined) {
    registerFulfillmentCommandHandlers(registry, deps.fulfillment);
    registered.push(
      "garment.transition",
      "garment.bulk_transition",
      "garment.rack.assign",
      "garment.rework",
      "garment.incident.record",
      "garment.mark_lost",
    );
  }

  if (deps.staffAccess !== undefined) {
    const handlers = createStaffAccessHandlers(deps.staffAccess);
    registry.registerHandler("staff.access.set", handlers["staff.access.set"]);
    registry.registerHandler("staff.create", handlers["staff.create"]);
    registry.registerHandler("staff.credentials.reset", handlers["staff.credentials.reset"]);
    registered.push("staff.access.set", "staff.create", "staff.credentials.reset");
  }

  if (deps.member !== undefined && deps.order !== undefined) {
    const memberOrder = deps.order;
    const handlers = createMemberHandlers({ ...deps.member, order: memberOrder });
    registry.registerHandler("member.account.open", handlers["member.account.open"]);
    registry.registerHandler("member.topup", handlers["member.topup"]);
    registry.registerHandler("member.balance.pay", handlers["member.balance.pay"]);
    registry.registerHandler("member.bonus_rule.upsert", handlers["member.bonus_rule.upsert"]);
    registry.registerHandler("member.refund", handlers["member.refund"]);
    registry.registerHandler("member.account.freeze", handlers["member.account.freeze"]);
    registry.registerHandler("member.account.unfreeze", handlers["member.account.unfreeze"]);
    registry.registerHandler("member.account.close", handlers["member.account.close"]);
    registered.push(
      "member.account.open",
      "member.topup",
      "member.balance.pay",
      "member.bonus_rule.upsert",
      "member.refund",
      "member.account.freeze",
      "member.account.unfreeze",
      "member.account.close",
    );
  }

  if (deps.notification !== undefined) {
    const handlers = createNotificationHandlers(deps.notification);
    registry.registerHandler(
      "notification.manual_list.create",
      handlers["notification.manual_list.create"],
    );
    registered.push("notification.manual_list.create");
  }

  return Object.freeze(registered);
}

export function registerM1QueryHandlers(
  queryRegistry: MutableQueryRegistry,
  deps: RegisterM1Deps,
): readonly string[] {
  const names: string[] = [];

  if (deps.platform !== undefined) {
    registerPlatformQueryHandlers(queryRegistry, deps.platform);
    names.push("platform.settings.get", "platform.store_features.get", "platform.audit.list");
  }

  if (deps.catalog !== undefined) {
    registerCatalogQueryHandlers(queryRegistry, deps.catalog);
    names.push("catalog.items.list", "catalog.items.get");
  }

  if (deps.order !== undefined) {
    registerOrderQueryHandlers(queryRegistry, deps.order);
    names.push("order.get");
  }

  if (deps.print !== undefined) {
    registerPrintQueryHandlers(queryRegistry, deps.print);
    names.push("print.jobs.list");
  }

  if (deps.stats !== undefined) {
    registerStatsQueryHandlers(queryRegistry, deps.stats);
    names.push("stats.day.summary");
  }

  if (deps.customer !== undefined) {
    registerCustomerQueryHandlers(queryRegistry, deps.customer);
    names.push(
      "customer.search",
      "customer.get",
      "customer.duplicates",
      "customer.privacy.status",
      "customer.privacy.events",
    );
  }

  if (deps.shift !== undefined) {
    registerShiftQueryHandlers(queryRegistry, deps.shift);
    names.push("shift.get", "shift.history");
  }

  if (deps.reconciliation !== undefined) {
    registerReconciliationQueryHandlers(queryRegistry, deps.reconciliation);
    names.push("reconciliation.day.get");
  }

  if (deps.accounting !== undefined) {
    const handlers = createAccountingHandlers(deps.accounting);
    queryRegistry.registerHandler("accounting.report.get", handlers["accounting.report.get"]);
    names.push("accounting.report.get");
  }

  if (deps.reporting !== undefined) {
    registerReportingQueryHandlers(queryRegistry, deps.reporting);
    names.push(
      "reporting.owner_dashboard.get",
      "reporting.owner_dashboard.drilldown",
      "reporting.owner_portfolio.get",
    );
  }

  if (deps.photo !== undefined) {
    registerPhotoQueryHandlers(queryRegistry, deps.photo);
    names.push("photo.list_by_order");
  }

  if (deps.fulfillment !== undefined) {
    registerFulfillmentQueryHandlers(queryRegistry, deps.fulfillment);
    names.push("fulfillment.workbench");
  }

  if (deps.staffAccess !== undefined) {
    const handlers = createStaffAccessHandlers(deps.staffAccess);
    queryRegistry.registerHandler("staff.access.list", handlers["staff.access.list"]);
    names.push("staff.access.list");
  }

  if (deps.member !== undefined && deps.order !== undefined) {
    const memberOrder = deps.order;
    const handlers = createMemberHandlers({ ...deps.member, order: memberOrder });
    queryRegistry.registerHandler("member.account.get", handlers["member.account.get"]);
    queryRegistry.registerHandler("member.bonus_rules.list", handlers["member.bonus_rules.list"]);
    names.push("member.account.get", "member.bonus_rules.list");
  }

  if (deps.notification !== undefined) {
    const handlers = createNotificationHandlers(deps.notification);
    queryRegistry.registerHandler(
      "notification.pickup_reminders.list",
      handlers["notification.pickup_reminders.list"],
    );
    names.push("notification.pickup_reminders.list");
  }

  return Object.freeze(names);
}

/**
 * Convenience: fresh M1 command + query registries + handlers + default chain hooks.
 * Query registry includes M2 catalog + order + print + stats + customer + shift + M3 photo;
 * handlers attach when deps set.
 */
export function createRegisteredM1Bus(
  deps: RegisterM1Deps,
  pendingStore: PendingActionStore = processPendingActionStore,
): RegisterM1Result {
  const registry = createM1CommandRegistry();
  const queryRegistry = createM1QueryRegistry();
  const registered = registerM1Handlers(registry, deps);
  const registeredQueries = registerM1QueryHandlers(queryRegistry, deps);
  return Object.freeze({
    registry,
    queryRegistry,
    chainHooks: createDefaultChainHooks(
      {},
      pendingStore,
      deps.member === undefined || deps.order === undefined
        ? undefined
        : createMemberTopupConfirmationPreparer(deps.member),
    ),
    registered,
    registeredQueries,
  });
}
