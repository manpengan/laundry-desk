import type { MutableQueryRegistry } from "../bus/query-registry.js";
import type { MutableCommandRegistry } from "../bus/registry.js";
import { createNotificationDeliveryHandlers } from "./delivery-handlers.js";
import { createNotificationHandlers } from "./handlers.js";
import type { NotificationHandlerDeps } from "./types.js";

export function registerNotificationCommands(
  registry: MutableCommandRegistry,
  deps: NotificationHandlerDeps | undefined,
): readonly string[] {
  if (deps === undefined) return Object.freeze([]);
  const handlers = createNotificationHandlers(deps);
  const deliveryHandlers = createNotificationDeliveryHandlers(deps);
  registry.registerHandler(
    "notification.manual_list.create",
    handlers["notification.manual_list.create"],
  );
  registry.registerHandler(
    "notification.delivery_batch.enqueue",
    deliveryHandlers["notification.delivery_batch.enqueue"],
  );
  return Object.freeze(["notification.manual_list.create", "notification.delivery_batch.enqueue"]);
}

export function registerNotificationQueries(
  registry: MutableQueryRegistry,
  deps: NotificationHandlerDeps | undefined,
): readonly string[] {
  if (deps === undefined) return Object.freeze([]);
  const handlers = createNotificationHandlers(deps);
  const deliveryHandlers = createNotificationDeliveryHandlers(deps);
  registry.registerHandler(
    "notification.pickup_reminders.list",
    handlers["notification.pickup_reminders.list"],
  );
  registry.registerHandler(
    "notification.delivery.capability.get",
    deliveryHandlers["notification.delivery.capability.get"],
  );
  registry.registerHandler(
    "notification.delivery_batches.list",
    deliveryHandlers["notification.delivery_batches.list"],
  );
  registry.registerHandler(
    "notification.delivery_batch.get",
    deliveryHandlers["notification.delivery_batch.get"],
  );
  return Object.freeze([
    "notification.pickup_reminders.list",
    "notification.delivery.capability.get",
    "notification.delivery_batches.list",
    "notification.delivery_batch.get",
  ]);
}
