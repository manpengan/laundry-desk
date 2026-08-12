import { describe, expect, it } from "vitest";

import {
  canTransitionDeliveryOrder,
  initialDeliveryOrderStatus,
  isDeliveryRouteSupported,
  validDeliveryOrderTransitions,
  type DeliveryOrderRoute,
} from "../lifecycle.js";

const PICKUP_DELIVERY: DeliveryOrderRoute = Object.freeze({
  collectionMethod: "pickup",
  returnMethod: "delivery",
});
const DROPOFF_DELIVERY: DeliveryOrderRoute = Object.freeze({
  collectionMethod: "store_dropoff",
  returnMethod: "delivery",
});
const PICKUP_SELF: DeliveryOrderRoute = Object.freeze({
  collectionMethod: "pickup",
  returnMethod: "self_pickup",
});

describe("delivery order lifecycle", () => {
  it("derives the authoritative initial state from the collection boundary", () => {
    expect(initialDeliveryOrderStatus(PICKUP_DELIVERY)).toBe("pickup_scheduled");
    expect(initialDeliveryOrderStatus(PICKUP_SELF)).toBe("pickup_scheduled");
    expect(initialDeliveryOrderStatus(DROPOFF_DELIVERY)).toBe("at_store");
  });

  it("rejects a route with neither a pickup nor a return leg", () => {
    const unsupported = Object.freeze({
      collectionMethod: "store_dropoff" as const,
      returnMethod: "self_pickup" as const,
    });
    expect(isDeliveryRouteSupported(unsupported)).toBe(false);
    expect(() => initialDeliveryOrderStatus(unsupported)).toThrow(/at least one delivery leg/u);
  });

  it("branches only at store custody and keeps terminal states irreversible", () => {
    expect(validDeliveryOrderTransitions("at_store", PICKUP_DELIVERY)).toEqual([
      "return_scheduled",
      "cancelled",
    ]);
    expect(validDeliveryOrderTransitions("at_store", PICKUP_SELF)).toEqual([
      "self_pickup_ready",
      "cancelled",
    ]);
    expect(canTransitionDeliveryOrder("return_scheduled", "completed", PICKUP_DELIVERY)).toBe(
      false,
    );
    expect(validDeliveryOrderTransitions("completed", PICKUP_DELIVERY)).toEqual([]);
    expect(validDeliveryOrderTransitions("cancelled", PICKUP_DELIVERY)).toEqual([]);
  });
});
