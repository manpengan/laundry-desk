export type DeliveryCollectionMethod = "pickup" | "store_dropoff";
export type DeliveryReturnMethod = "delivery" | "self_pickup";

export type DeliveryOrderStatus =
  | "pickup_scheduled"
  | "pickup_in_progress"
  | "picked_up"
  | "at_store"
  | "return_scheduled"
  | "return_in_progress"
  | "self_pickup_ready"
  | "completed"
  | "cancelled";

export const DELIVERY_ORDER_TERMINAL_STATUSES: ReadonlySet<DeliveryOrderStatus> = new Set([
  "completed",
  "cancelled",
]);

const COMMON_TRANSITIONS = Object.freeze({
  pickup_scheduled: Object.freeze(["pickup_in_progress", "cancelled"]),
  pickup_in_progress: Object.freeze(["picked_up", "cancelled"]),
  picked_up: Object.freeze(["at_store"]),
  at_store: Object.freeze(["cancelled"]),
  return_scheduled: Object.freeze(["return_in_progress", "cancelled"]),
  return_in_progress: Object.freeze(["completed"]),
  self_pickup_ready: Object.freeze(["completed"]),
  completed: Object.freeze([]),
  cancelled: Object.freeze([]),
} satisfies Readonly<Record<DeliveryOrderStatus, readonly DeliveryOrderStatus[]>>);

export type DeliveryOrderRoute = Readonly<{
  collectionMethod: DeliveryCollectionMethod;
  returnMethod: DeliveryReturnMethod;
}>;

export function isDeliveryRouteSupported(route: DeliveryOrderRoute): boolean {
  return route.collectionMethod === "pickup" || route.returnMethod === "delivery";
}

export function initialDeliveryOrderStatus(route: DeliveryOrderRoute): DeliveryOrderStatus {
  if (!isDeliveryRouteSupported(route)) {
    throw new TypeError("A delivery order must contain at least one delivery leg");
  }
  return route.collectionMethod === "pickup" ? "pickup_scheduled" : "at_store";
}

export function validDeliveryOrderTransitions(
  status: DeliveryOrderStatus,
  route: DeliveryOrderRoute,
): readonly DeliveryOrderStatus[] {
  if (!isDeliveryRouteSupported(route)) return Object.freeze([]);
  if (status !== "at_store") return COMMON_TRANSITIONS[status];
  return route.returnMethod === "delivery"
    ? Object.freeze(["return_scheduled", "cancelled"])
    : Object.freeze(["self_pickup_ready", "cancelled"]);
}

export function canTransitionDeliveryOrder(
  status: DeliveryOrderStatus,
  target: DeliveryOrderStatus,
  route: DeliveryOrderRoute,
): boolean {
  return validDeliveryOrderTransitions(status, route).includes(target);
}
