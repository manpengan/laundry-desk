import { createAccountingHandlers } from "../accounting/handlers.js";
import { createM1CommandRegistry, type MutableCommandRegistry } from "../bus/registry.js";
import { createM1QueryRegistry, type MutableQueryRegistry } from "../bus/query-registry.js";
import {
  registerCatalogCommandHandlers,
  registerCatalogQueryHandlers,
} from "../catalog/handlers.js";
import {
  registerCustomerCommandHandlers,
  registerCustomerQueryHandlers,
} from "../customer/handlers.js";
import {
  registerCustomerProfileCommandHandlers,
  registerCustomerProfileQueryHandlers,
} from "../customer-profile/handlers.js";
import {
  registerDeliveryPolicyCommandHandlers,
  registerDeliveryPolicyQueryHandlers,
} from "../delivery-policy/handlers.js";
import {
  registerDeliveryAppointmentCommandHandlers,
  registerDeliveryAppointmentQueryHandlers,
} from "../delivery-appointments/handlers.js";
import {
  registerDeliveryOrderCommandHandlers,
  registerDeliveryOrderQueryHandlers,
} from "../delivery-orders/handlers.js";
import {
  registerDeliveryTaskCommandHandlers,
  registerDeliveryTaskQueryHandlers,
} from "../delivery-tasks/handlers.js";
import { registerOrderCommandHandlers, registerOrderQueryHandlers } from "../order/handlers.js";
import {
  registerFulfillmentCommandHandlers,
  registerFulfillmentQueryHandlers,
} from "../fulfillment/handlers.js";
import { registerOrderWorkdayCommandHandlers } from "../order/workday-handlers.js";
import {
  registerPaymentCommandHandlers,
  registerPaymentQueryHandlers,
} from "../payment/handlers.js";
import { registerPhotoCommandHandlers, registerPhotoQueryHandlers } from "../photo/handlers.js";
import { registerPrintCommandHandlers, registerPrintQueryHandlers } from "../print/handlers.js";
import {
  registerPricingCommandHandlers,
  registerPricingQueryHandlers,
} from "../pricing/handlers.js";
import {
  registerReconciliationCommandHandlers,
  registerReconciliationQueryHandlers,
} from "../reconciliation/handlers.js";
import { registerReportingQueryHandlers } from "../reporting/handlers.js";
import { registerShiftCommandHandlers, registerShiftQueryHandlers } from "../shift/handlers.js";
import { registerStatsQueryHandlers } from "../stats/handlers.js";
import * as memberRegistration from "../member/registration.js";
import { withMemberBenefitCouponCancellation } from "../member-benefits/order-cancellation.js";
import * as notificationRegistration from "../notification/registration.js";
import { processPendingActionStore } from "../pending-actions/process-store.js";
import type { PendingActionStore } from "../pending-actions/types.js";
import { createStaffAccessHandlers } from "../staff/handlers.js";
import * as storeManagement from "../store-management/registration.js";
import { registerIdentityCommandHandlers } from "./identity-handlers.js";
import { registerPlatformHandlers, registerPlatformQueryHandlers } from "./platform-handlers.js";
import { createM1ChainHooks } from "./register-m1-chain-hooks.js";
import type { RegisterM1Deps, RegisterM1Result } from "./register-m1-types.js";

export type { RegisterM1Deps, RegisterM1Result } from "./register-m1-types.js";

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

  if (deps.pricing !== undefined) {
    registerPricingCommandHandlers(registry, deps.pricing);
    registered.push("pricing.policy.set");
  }

  if (deps.deliveryPolicy !== undefined) {
    registerDeliveryPolicyCommandHandlers(registry, deps.deliveryPolicy);
    registered.push("delivery.policy.set");
  }

  if (deps.deliveryAppointments !== undefined) {
    registerDeliveryAppointmentCommandHandlers(registry, deps.deliveryAppointments);
    registered.push(
      "delivery.appointment.create",
      "delivery.appointment.reschedule",
      "delivery.appointment.cancel",
    );
  }

  if (deps.deliveryOrders !== undefined) {
    registerDeliveryOrderCommandHandlers(registry, deps.deliveryOrders);
    registered.push("delivery.order.create", "delivery.order.transition");
  }

  if (deps.deliveryTasks !== undefined) {
    registerDeliveryTaskCommandHandlers(registry, deps.deliveryTasks);
    registered.push(
      "delivery.task.assign",
      "delivery.task.respond",
      "delivery.task.transfer",
      "delivery.task.takeover",
    );
  }

  // ADR-15: price maintenance is a command; the query side stays read-only.
  if (deps.catalog !== undefined) {
    registerCatalogCommandHandlers(registry, deps.catalog);
    registered.push("catalog.item.upsert", "catalog.items.reorder");
  }

  if (deps.order !== undefined) {
    const orderWithCouponCancellation = withMemberBenefitCouponCancellation(
      deps.order,
      deps.memberBenefits,
    );
    registerOrderCommandHandlers(registry, deps.order);
    registerOrderWorkdayCommandHandlers(registry, orderWithCouponCancellation);
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

  if (deps.customerProfile !== undefined) {
    registerCustomerProfileCommandHandlers(registry, deps.customerProfile);
    registered.push("customer.profile.set", "customer.discount_policy.set");
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
      "fulfillment.batch.create",
      "fulfillment.batch.cancel",
      "fulfillment.handoff.checkpoint.record",
      "fulfillment.handoff.discrepancy.resolve",
      "fulfillment.quality_check.record",
    );
  }

  if (deps.staffAccess !== undefined) {
    const handlers = createStaffAccessHandlers(deps.staffAccess);
    registry.registerHandler("staff.access.set", handlers["staff.access.set"]);
    registry.registerHandler("staff.create", handlers["staff.create"]);
    registry.registerHandler("staff.credentials.reset", handlers["staff.credentials.reset"]);
    registered.push("staff.access.set", "staff.create", "staff.credentials.reset");
  }

  registered.push(...storeManagement.registerCommands(registry, deps.storeManagement));

  registered.push(...memberRegistration.registerCommands(registry, deps));

  registered.push(
    ...notificationRegistration.registerNotificationCommands(registry, deps.notification),
  );

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

  if (deps.pricing !== undefined) {
    registerPricingQueryHandlers(queryRegistry, deps.pricing);
    names.push("pricing.policy.get");
  }

  if (deps.deliveryPolicy !== undefined) {
    registerDeliveryPolicyQueryHandlers(queryRegistry, deps.deliveryPolicy);
    names.push("delivery.policy.get", "delivery.availability.quote");
  }

  if (deps.deliveryAppointments !== undefined) {
    registerDeliveryAppointmentQueryHandlers(queryRegistry, deps.deliveryAppointments);
    names.push(
      "delivery.appointment.get",
      "delivery.appointment.addresses.list",
      "delivery.appointments.list",
    );
  }

  if (deps.deliveryOrders !== undefined) {
    registerDeliveryOrderQueryHandlers(queryRegistry, deps.deliveryOrders);
    names.push("delivery.order.get", "delivery.orders.list");
  }

  if (deps.deliveryTasks !== undefined) {
    registerDeliveryTaskQueryHandlers(queryRegistry, deps.deliveryTasks);
    names.push("delivery.task.get", "delivery.tasks.list");
  }

  if (deps.catalog !== undefined) {
    registerCatalogQueryHandlers(queryRegistry, deps.catalog);
    names.push(
      "catalog.items.list",
      "catalog.items.get",
      "catalog.items.manage.list",
      "catalog.audit.list",
    );
  }

  if (deps.order !== undefined) {
    registerOrderQueryHandlers(queryRegistry, deps.order);
    registerPaymentQueryHandlers(queryRegistry, deps.order);
    names.push("order.get", "order.list", "order.lookup", "payment.ledger.list");
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

  if (deps.customerProfile !== undefined) {
    registerCustomerProfileQueryHandlers(queryRegistry, deps.customerProfile);
    names.push("customer.profile.get");
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
    names.push("fulfillment.workbench", "fulfillment.batches.list", "fulfillment.batch.get");
  }

  if (deps.staffAccess !== undefined) {
    const handlers = createStaffAccessHandlers(deps.staffAccess);
    queryRegistry.registerHandler("staff.access.list", handlers["staff.access.list"]);
    names.push("staff.access.list");
  }

  names.push(...storeManagement.registerQueries(queryRegistry, deps.storeManagement));

  names.push(...memberRegistration.registerQueries(queryRegistry, deps));

  names.push(
    ...notificationRegistration.registerNotificationQueries(queryRegistry, deps.notification),
  );

  return Object.freeze(names);
}

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
    chainHooks: createM1ChainHooks(deps, pendingStore),
    registered,
    registeredQueries,
  });
}
