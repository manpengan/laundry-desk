import type { MutableQueryRegistry } from "../bus/query-registry.js";
import type { MutableCommandRegistry } from "../bus/registry.js";
import {
  registerDeliveryAppointmentCommandHandlers,
  registerDeliveryAppointmentQueryHandlers,
  type DeliveryAppointmentHandlerDeps,
} from "../delivery-appointments/handlers.js";
import {
  registerDeliveryEvidenceCommandHandlers,
  registerDeliveryEvidenceQueryHandlers,
  type DeliveryEvidenceHandlerDeps,
} from "../delivery-evidence/handlers.js";
import {
  registerDeliveryOrderCommandHandlers,
  registerDeliveryOrderQueryHandlers,
  type DeliveryOrderHandlerDeps,
} from "../delivery-orders/handlers.js";
import {
  registerDeliveryPolicyCommandHandlers,
  registerDeliveryPolicyQueryHandlers,
  type DeliveryPolicyHandlerDeps,
} from "../delivery-policy/handlers.js";
import {
  registerDeliveryTaskCommandHandlers,
  registerDeliveryTaskQueryHandlers,
  type DeliveryTaskHandlerDeps,
} from "../delivery-tasks/handlers.js";
import { createMarketingCampaignConfirmationPreparer } from "../marketing/confirmation.js";
import type { MarketingHandlerDeps } from "../marketing/types.js";
import * as marketingRegistration from "../marketing/registration.js";
import type { NotificationHandlerDeps } from "../notification/types.js";
import * as notificationRegistration from "../notification/registration.js";
import type { PendingActionPreparer } from "./default-chain-hooks.js";

export type Stage4RegistrationDeps = Readonly<{
  deliveryPolicy?: DeliveryPolicyHandlerDeps;
  deliveryAppointments?: DeliveryAppointmentHandlerDeps;
  deliveryOrders?: DeliveryOrderHandlerDeps;
  deliveryTasks?: DeliveryTaskHandlerDeps;
  deliveryEvidence?: DeliveryEvidenceHandlerDeps;
  notification?: NotificationHandlerDeps;
  marketing?: MarketingHandlerDeps;
}>;

function registerDeliveryCommands(
  registry: MutableCommandRegistry,
  deps: Stage4RegistrationDeps,
): readonly string[] {
  const names: string[] = [];
  if (deps.deliveryPolicy !== undefined) {
    registerDeliveryPolicyCommandHandlers(registry, deps.deliveryPolicy);
    names.push("delivery.policy.set");
  }
  if (deps.deliveryAppointments !== undefined) {
    registerDeliveryAppointmentCommandHandlers(registry, deps.deliveryAppointments);
    names.push(
      "delivery.appointment.create",
      "delivery.appointment.reschedule",
      "delivery.appointment.cancel",
    );
  }
  if (deps.deliveryOrders !== undefined) {
    registerDeliveryOrderCommandHandlers(registry, deps.deliveryOrders);
    names.push("delivery.order.create", "delivery.order.transition");
  }
  if (deps.deliveryTasks !== undefined) {
    registerDeliveryTaskCommandHandlers(registry, deps.deliveryTasks);
    names.push(
      "delivery.task.assign",
      "delivery.task.respond",
      "delivery.task.transfer",
      "delivery.task.takeover",
    );
  }
  if (deps.deliveryEvidence !== undefined) {
    registerDeliveryEvidenceCommandHandlers(registry, deps.deliveryEvidence);
    names.push("delivery.evidence.record");
  }
  return Object.freeze(names);
}

function registerDeliveryQueries(
  registry: MutableQueryRegistry,
  deps: Stage4RegistrationDeps,
): readonly string[] {
  const names: string[] = [];
  if (deps.deliveryPolicy !== undefined) {
    registerDeliveryPolicyQueryHandlers(registry, deps.deliveryPolicy);
    names.push("delivery.policy.get", "delivery.availability.quote");
  }
  if (deps.deliveryAppointments !== undefined) {
    registerDeliveryAppointmentQueryHandlers(registry, deps.deliveryAppointments);
    names.push(
      "delivery.appointments.list",
      "delivery.appointment.get",
      "delivery.appointment.addresses.list",
    );
  }
  if (deps.deliveryOrders !== undefined) {
    registerDeliveryOrderQueryHandlers(registry, deps.deliveryOrders);
    names.push("delivery.orders.list", "delivery.order.get");
  }
  if (deps.deliveryTasks !== undefined) {
    registerDeliveryTaskQueryHandlers(registry, deps.deliveryTasks);
    names.push("delivery.tasks.list", "delivery.task.get");
  }
  if (deps.deliveryEvidence !== undefined) {
    registerDeliveryEvidenceQueryHandlers(registry, deps.deliveryEvidence);
    names.push("delivery.evidence.list");
  }
  return Object.freeze(names);
}

export function registerStage4Commands(
  registry: MutableCommandRegistry,
  deps: Stage4RegistrationDeps,
): readonly string[] {
  return Object.freeze([
    ...registerDeliveryCommands(registry, deps),
    ...notificationRegistration.registerNotificationCommands(registry, deps.notification),
    ...marketingRegistration.registerMarketingCommands(registry, deps.marketing),
  ]);
}

export function registerStage4Queries(
  registry: MutableQueryRegistry,
  deps: Stage4RegistrationDeps,
): readonly string[] {
  return Object.freeze([
    ...registerDeliveryQueries(registry, deps),
    ...notificationRegistration.registerNotificationQueries(registry, deps.notification),
    ...marketingRegistration.registerMarketingQueries(registry, deps.marketing),
  ]);
}

export function createStage4PendingActionPreparers(
  deps: Stage4RegistrationDeps,
): readonly (PendingActionPreparer | undefined)[] {
  return Object.freeze([
    deps.marketing === undefined
      ? undefined
      : createMarketingCampaignConfirmationPreparer(deps.marketing),
  ]);
}
