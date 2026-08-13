import { describe, expect, it } from "vitest";

import {
  DELIVERY_TASK_COMMAND_NAMES,
  DELIVERY_TASK_QUERY_NAMES,
  DeliveryTaskAssignInputSchema,
  DeliveryTaskConfirmationSummarySchema,
  DeliveryTaskRespondInputSchema,
  DeliveryTaskTakeoverInputSchema,
  DeliveryTaskTransferInputSchema,
  M2_READ_ONLY_AI_DEFINITIONS,
  createCommandError,
} from "../src/index.js";

const ORDER = "11111111-1111-4111-8111-111111111111";
const TASK = "22222222-2222-4222-8222-222222222222";
const STAFF = "33333333-3333-4333-8333-333333333333";

describe("delivery task contracts", () => {
  it("freezes four online writes and two bounded internal reads", () => {
    expect(DELIVERY_TASK_COMMAND_NAMES).toEqual([
      "delivery.task.assign",
      "delivery.task.respond",
      "delivery.task.transfer",
      "delivery.task.takeover",
    ]);
    expect(DELIVERY_TASK_QUERY_NAMES).toEqual(["delivery.task.get", "delivery.tasks.list"]);
    expect(M2_READ_ONLY_AI_DEFINITIONS.map(({ name }) => name)).not.toContain(
      "delivery.tasks.list",
    );
  });

  it("rejects tenant fields and enforces controlled response reasons", () => {
    expect(
      DeliveryTaskAssignInputSchema.safeParse({
        delivery_order_id: ORDER,
        leg: "pickup",
        expected_delivery_order_version: 1,
        assignee_staff_id: STAFF,
        store_id: STAFF,
      }).success,
    ).toBe(false);
    expect(
      DeliveryTaskRespondInputSchema.safeParse({
        delivery_order_id: ORDER,
        leg: "pickup",
        delivery_task_id: TASK,
        expected_version: 1,
        decision: "reject",
      }).success,
    ).toBe(false);
    expect(
      DeliveryTaskRespondInputSchema.safeParse({
        delivery_order_id: ORDER,
        leg: "pickup",
        delivery_task_id: TASK,
        expected_version: 1,
        decision: "accept",
        resolution_reason: "other",
      }).success,
    ).toBe(false);
  });

  it("keeps transfer and takeover shapes distinct", () => {
    const base = {
      delivery_order_id: ORDER,
      leg: "return",
      delivery_task_id: TASK,
      expected_version: 2,
      resolution_reason: "shift_end",
    } as const;
    expect(
      DeliveryTaskTransferInputSchema.safeParse({ ...base, target_staff_id: STAFF }).success,
    ).toBe(true);
    expect(
      DeliveryTaskTakeoverInputSchema.safeParse({ ...base, target_staff_id: STAFF }).success,
    ).toBe(false);
  });

  it("validates a server-derived assignment confirmation snapshot", () => {
    const summary = {
      kind: "delivery_task_operation",
      operation: "assign",
      delivery_order_id: ORDER,
      delivery_order_version: 3,
      leg: "return",
      delivery_task_id: null,
      delivery_task_version: null,
      current_status: null,
      from_assignee_staff_id: null,
      to_assignee_staff_id: STAFF,
      decision: null,
      resolution_reason: null,
    } as const;
    expect(DeliveryTaskConfirmationSummarySchema.safeParse(summary).success).toBe(true);

    const error = createCommandError("POLICY_CONFIRMATION_REQUIRED", {
      kind: "confirmation",
      confirm_ref: TASK,
      summary,
    });
    if (
      error.detail?.kind === "confirmation" &&
      error.detail.summary?.kind === "delivery_task_operation"
    ) {
      expect(Object.isFrozen(error.detail.summary)).toBe(true);
    } else {
      throw new Error("Expected a delivery task confirmation summary");
    }
  });
});
