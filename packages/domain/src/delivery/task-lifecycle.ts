export type DeliveryTaskStatus =
  "offered" | "accepted" | "rejected" | "transferred" | "taken_over" | "completed" | "cancelled";

export type DeliveryTaskLeg = "pickup" | "return";

export const DELIVERY_TASK_ACTIVE_STATUSES: ReadonlySet<DeliveryTaskStatus> = new Set([
  "offered",
  "accepted",
]);

export const DELIVERY_TASK_TERMINAL_STATUSES: ReadonlySet<DeliveryTaskStatus> = new Set([
  "rejected",
  "transferred",
  "taken_over",
  "completed",
  "cancelled",
]);

const TRANSITIONS = Object.freeze<
  Readonly<Record<DeliveryTaskStatus, readonly DeliveryTaskStatus[]>>
>({
  offered: Object.freeze(["accepted", "rejected", "transferred", "taken_over", "cancelled"]),
  accepted: Object.freeze(["transferred", "taken_over", "completed", "cancelled"]),
  rejected: Object.freeze([]),
  transferred: Object.freeze([]),
  taken_over: Object.freeze([]),
  completed: Object.freeze([]),
  cancelled: Object.freeze([]),
});

export function validDeliveryTaskTransitions(status: DeliveryTaskStatus) {
  return TRANSITIONS[status];
}

export function canTransitionDeliveryTask(
  status: DeliveryTaskStatus,
  target: DeliveryTaskStatus,
): boolean {
  return TRANSITIONS[status].includes(target);
}

export function deliveryTaskLegMatchesRoute(
  leg: DeliveryTaskLeg,
  route: Readonly<{
    collectionMethod: "pickup" | "store_dropoff";
    returnMethod: "delivery" | "self_pickup";
  }>,
): boolean {
  return leg === "pickup" ? route.collectionMethod === "pickup" : route.returnMethod === "delivery";
}

export function deliveryTaskAssignableOrderStatus(leg: DeliveryTaskLeg) {
  return leg === "pickup" ? "pickup_scheduled" : "return_scheduled";
}
