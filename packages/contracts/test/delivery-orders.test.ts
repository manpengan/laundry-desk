import { describe, expect, it } from "vitest";

import {
  DeliveryOrderCreateInputSchema,
  DeliveryOrderTransitionInputSchema,
  DeliveryOrdersListInputSchema,
  M2_READ_ONLY_AI_DEFINITIONS,
  deliveryOrderCreateCommand,
  deliveryOrderGetQuery,
  deliveryOrderTransitionCommand,
  deliveryOrdersListQuery,
} from "../src/index.js";

const ORDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const APPOINTMENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RETURN_APPOINTMENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("delivery order contracts", () => {
  it("freezes two confirmed writes and two bounded PII reads outside AI", () => {
    for (const command of [deliveryOrderCreateCommand, deliveryOrderTransitionCommand]) {
      expect(command).toMatchObject({
        risk: "R3",
        offline_mode: "denied",
        data_classification: "pii",
        idempotent: true,
      });
    }
    expect(deliveryOrderGetQuery).toMatchObject({
      risk: "R2",
      max_result_rows: 1,
      invariants: ["rbac.delivery_read"],
    });
    expect(deliveryOrdersListQuery).toMatchObject({
      risk: "R2",
      max_result_rows: 100,
      invariants: ["rbac.delivery_read"],
    });
    const aiNames = M2_READ_ONLY_AI_DEFINITIONS.map(({ name }) => name);
    expect(aiNames).not.toContain("delivery.order.get");
    expect(aiNames).not.toContain("delivery.orders.list");
  });

  it("requires exactly the appointment references implied by both route methods", () => {
    expect(
      DeliveryOrderCreateInputSchema.parse({
        laundry_order_id: ORDER_ID,
        customer_id: ORDER_ID,
        collection_method: "pickup",
        return_method: "delivery",
        pickup_appointment_id: APPOINTMENT_ID,
        return_appointment_id: RETURN_APPOINTMENT_ID,
      }),
    ).toBeDefined();
    expect(
      DeliveryOrderCreateInputSchema.parse({
        laundry_order_id: ORDER_ID,
        customer_id: ORDER_ID,
        collection_method: "store_dropoff",
        return_method: "delivery",
        return_appointment_id: RETURN_APPOINTMENT_ID,
      }),
    ).toBeDefined();
    for (const invalid of [
      {
        laundry_order_id: ORDER_ID,
        customer_id: ORDER_ID,
        collection_method: "pickup",
        return_method: "self_pickup",
      },
      {
        laundry_order_id: ORDER_ID,
        customer_id: ORDER_ID,
        collection_method: "store_dropoff",
        return_method: "self_pickup",
      },
      {
        laundry_order_id: ORDER_ID,
        customer_id: ORDER_ID,
        collection_method: "store_dropoff",
        return_method: "delivery",
        pickup_appointment_id: APPOINTMENT_ID,
        return_appointment_id: RETURN_APPOINTMENT_ID,
      },
    ]) {
      expect(DeliveryOrderCreateInputSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("rejects tenant, customer, fee and initial-state injection", () => {
    const valid = {
      laundry_order_id: ORDER_ID,
      customer_id: ORDER_ID,
      collection_method: "pickup",
      return_method: "self_pickup",
      pickup_appointment_id: APPOINTMENT_ID,
    } as const;
    for (const extra of [
      { org_id: ORDER_ID },
      { store_id: ORDER_ID },
      { customer_name: "private" },
      { total_fee_cents: 100 },
      { status: "completed" },
      { version: 9 },
    ]) {
      expect(DeliveryOrderCreateInputSchema.safeParse({ ...valid, ...extra }).success).toBe(false);
    }
  });

  it("requires CAS and a controlled cancellation reason only for cancelled", () => {
    expect(
      DeliveryOrderTransitionInputSchema.parse({
        delivery_order_id: ORDER_ID,
        customer_id: ORDER_ID,
        expected_version: 2,
        target_status: "picked_up",
      }),
    ).toBeDefined();
    expect(
      DeliveryOrderTransitionInputSchema.parse({
        delivery_order_id: ORDER_ID,
        customer_id: ORDER_ID,
        expected_version: 2,
        target_status: "cancelled",
        cancellation_reason: "customer_request",
      }),
    ).toBeDefined();
    expect(
      DeliveryOrderTransitionInputSchema.safeParse({
        delivery_order_id: ORDER_ID,
        customer_id: ORDER_ID,
        expected_version: 2,
        target_status: "cancelled",
      }).success,
    ).toBe(false);
    expect(
      DeliveryOrderTransitionInputSchema.safeParse({
        delivery_order_id: ORDER_ID,
        customer_id: ORDER_ID,
        expected_version: 2,
        target_status: "picked_up",
        cancellation_reason: "other",
      }).success,
    ).toBe(false);
  });

  it("bounds the store worklist", () => {
    expect(DeliveryOrdersListInputSchema.parse({})).toEqual({});
    expect(DeliveryOrdersListInputSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(DeliveryOrdersListInputSchema.safeParse({ address: "private" }).success).toBe(false);
  });
});
