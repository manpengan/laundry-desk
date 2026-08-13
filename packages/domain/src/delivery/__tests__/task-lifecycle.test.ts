import { describe, expect, it } from "vitest";

import {
  canTransitionDeliveryTask,
  deliveryTaskAssignableOrderStatus,
  deliveryTaskLegMatchesRoute,
  validDeliveryTaskTransitions,
} from "../task-lifecycle.js";

describe("delivery task lifecycle", () => {
  it("freezes offered and accepted task transitions", () => {
    expect(validDeliveryTaskTransitions("offered")).toEqual([
      "accepted",
      "rejected",
      "transferred",
      "taken_over",
      "cancelled",
    ]);
    expect(validDeliveryTaskTransitions("accepted")).toEqual([
      "transferred",
      "taken_over",
      "completed",
      "cancelled",
    ]);
    expect(canTransitionDeliveryTask("rejected", "offered")).toBe(false);
    expect(canTransitionDeliveryTask("completed", "accepted")).toBe(false);
  });

  it("binds pickup and return tasks to supported route legs", () => {
    expect(
      deliveryTaskLegMatchesRoute("pickup", {
        collectionMethod: "pickup",
        returnMethod: "self_pickup",
      }),
    ).toBe(true);
    expect(
      deliveryTaskLegMatchesRoute("return", {
        collectionMethod: "pickup",
        returnMethod: "self_pickup",
      }),
    ).toBe(false);
    expect(deliveryTaskAssignableOrderStatus("pickup")).toBe("pickup_scheduled");
    expect(deliveryTaskAssignableOrderStatus("return")).toBe("return_scheduled");
  });
});
