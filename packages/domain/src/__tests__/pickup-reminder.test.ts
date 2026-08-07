import { describe, expect, it } from "vitest";

import {
  DEFAULT_PICKUP_REMINDER_TEMPLATE,
  groupPickupReminders,
  isPickupReminderTemplate,
  renderPickupReminder,
} from "../notification/pickup-reminder.js";

const rows = Object.freeze([
  Object.freeze({
    order_id: "order-a",
    ticket_no: "T-001",
    customer_id: "customer-a",
    customer_name: "张三",
    customer_phone: "13800000000",
    garment_count: 2,
    balance_cents: 500,
  }),
  Object.freeze({
    order_id: "order-b",
    ticket_no: "T-002",
    customer_id: "customer-a",
    customer_name: "张三",
    customer_phone: "13800000000",
    garment_count: 1,
    balance_cents: 0,
  }),
]);

describe("pickup reminder domain", () => {
  it("keeps order grouping one row per selected order", () => {
    const grouped = groupPickupReminders(rows, "order");
    expect(grouped).toHaveLength(2);
    expect(grouped[0]).toMatchObject({ order_ids: ["order-a"], garment_count: 2 });
  });

  it("groups the same customer and phone with safe integer totals", () => {
    const grouped = groupPickupReminders(rows, "customer");
    expect(grouped).toEqual([
      expect.objectContaining({
        order_ids: ["order-a", "order-b"],
        ticket_nos: ["T-001", "T-002"],
        garment_count: 3,
        balance_cents: 500,
      }),
    ]);
  });

  it("does not merge a customer id across different phone snapshots", () => {
    const grouped = groupPickupReminders(
      [...rows, { ...rows[1]!, order_id: "order-c", customer_phone: "13900000000" }],
      "customer",
    );
    expect(grouped).toHaveLength(2);
  });

  it("renders only the three frozen placeholders", () => {
    const [group] = groupPickupReminders(rows, "customer");
    expect(group).toBeDefined();
    expect(renderPickupReminder(DEFAULT_PICKUP_REMINDER_TEMPLATE, group!)).toContain(
      "T-001、T-002共3件",
    );
    expect(isPickupReminderTemplate("{{tickets}} / {{unknown}}")).toBe(false);
    expect(() => renderPickupReminder("{{unknown}}", group!)).toThrow(/unsupported/u);
  });

  it("rejects unsafe totals before aggregation", () => {
    expect(() =>
      groupPickupReminders([{ ...rows[0]!, garment_count: Number.MAX_SAFE_INTEGER }], "order"),
    ).not.toThrow();
    expect(() =>
      groupPickupReminders(
        [rows[0]!, { ...rows[1]!, garment_count: Number.MAX_SAFE_INTEGER }],
        "customer",
      ),
    ).toThrow(RangeError);
  });
});
