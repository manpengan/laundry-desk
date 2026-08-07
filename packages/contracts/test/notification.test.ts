import { describe, expect, it } from "vitest";

import {
  NotificationManualListCreateInputSchema,
  PickupReminderListInputSchema,
  notificationManualListCreateCommand,
  pickupReminderListQuery,
} from "../src/commands/notification.js";

const ORDER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function orderId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function validManualInput() {
  return {
    order_ids: [ORDER_ID],
    group_by: "order" as const,
    message_template: "订单{{tickets}}共{{garment_count}}件，欠{{balance_cents}}分",
    format: "csv" as const,
    min_age_days: 90 as const,
    unpaid_only: false,
    garment_statuses: ["ready", "racked"] as const,
  };
}

describe("ADR-23 notification contracts", () => {
  it("keeps the candidate query bounded, PII-classified and outside offline execution", () => {
    expect(
      PickupReminderListInputSchema.parse({
        min_age_days: 180,
        unpaid_only: true,
        garment_statuses: ["racked"],
        limit: 200,
      }),
    ).toMatchObject({ min_age_days: 180, limit: 200 });
    expect(pickupReminderListQuery).toMatchObject({
      risk: "R2",
      offline_mode: "denied",
      data_classification: "pii",
      max_result_rows: 200,
    });
    expect(pickupReminderListQuery.result_redaction).toEqual([
      { path: "/candidates/*/customer_phone", strategy: "mask" },
    ]);
  });

  it("rejects duplicate statuses, oversized results and unknown filter keys", () => {
    expect(() =>
      PickupReminderListInputSchema.parse({ garment_statuses: ["ready", "ready"] }),
    ).toThrow();
    expect(() => PickupReminderListInputSchema.parse({ limit: 201 })).toThrow();
    expect(() => PickupReminderListInputSchema.parse({ store_id: ORDER_ID })).toThrow();
  });

  it("accepts only the three frozen message placeholders", () => {
    expect(NotificationManualListCreateInputSchema.parse(validManualInput())).toMatchObject({
      order_ids: [ORDER_ID],
      format: "csv",
    });
    expect(() =>
      NotificationManualListCreateInputSchema.parse({
        ...validManualInput(),
        message_template: "您好 {{customer_name}}",
      }),
    ).toThrow(/unsupported placeholder/u);
  });

  it("hard-caps one confirmation at 50 unique orders", () => {
    expect(
      NotificationManualListCreateInputSchema.parse({
        ...validManualInput(),
        order_ids: Array.from({ length: 50 }, (_, index) => orderId(index)),
      }).order_ids,
    ).toHaveLength(50);
    expect(() =>
      NotificationManualListCreateInputSchema.parse({
        ...validManualInput(),
        order_ids: Array.from({ length: 51 }, (_, index) => orderId(index)),
      }),
    ).toThrow();
    expect(() =>
      NotificationManualListCreateInputSchema.parse({
        ...validManualInput(),
        order_ids: [ORDER_ID, ORDER_ID],
      }),
    ).toThrow(/unique/u);
    expect(notificationManualListCreateCommand).toMatchObject({
      risk: "R3",
      offline_mode: "denied",
      hard_limits: { max_batch: 50 },
    });
  });
});
