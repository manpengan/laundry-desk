import { describe, expect, it } from "vitest";

import {
  NotificationDeliveryBatchEnqueueInputSchema,
  NotificationDeliveryBatchGetResultSchema,
  NotificationDeliveryCapabilityResultSchema,
  notificationDeliveryBatchEnqueueCommand,
  notificationDeliveryBatchGetQuery,
  notificationDeliveryBatchesListQuery,
  notificationDeliveryCapabilityQuery,
} from "../src/index.js";

const ORDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BATCH_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DELIVERY_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AT = "2026-08-12T01:02:03.000Z";

function enqueueInput(orderIds: readonly string[] = [ORDER_ID]) {
  return {
    order_ids: orderIds,
    channel: "sms",
    template_code: "pickup_reminder_v1",
    max_cost_cents: 0,
    min_age_days: 30,
    unpaid_only: false,
    garment_statuses: ["ready"],
  };
}

describe("ADR-44 notification delivery contracts", () => {
  it("accepts only a strict bounded server-template enqueue input", () => {
    expect(NotificationDeliveryBatchEnqueueInputSchema.parse(enqueueInput())).toEqual(
      enqueueInput(),
    );
    expect(() =>
      NotificationDeliveryBatchEnqueueInputSchema.parse({
        ...enqueueInput(),
        customer_phone: "13800138000",
      }),
    ).toThrow();
    expect(() =>
      NotificationDeliveryBatchEnqueueInputSchema.parse({
        ...enqueueInput(),
        message: "arbitrary body",
      }),
    ).toThrow();
    expect(() =>
      NotificationDeliveryBatchEnqueueInputSchema.parse(enqueueInput([ORDER_ID, ORDER_ID])),
    ).toThrow();
    expect(() =>
      NotificationDeliveryBatchEnqueueInputSchema.parse(
        enqueueInput(
          Array.from(
            { length: 51 },
            (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          ),
        ),
      ),
    ).toThrow();
  });

  it("freezes R3 to R4 batch escalation and excludes every delivery surface from offline", () => {
    expect(notificationDeliveryBatchEnqueueCommand).toMatchObject({
      name: "notification.delivery_batch.enqueue",
      risk: "R3",
      idempotent: true,
      offline_mode: "denied",
      data_classification: "pii",
      input_redaction: [{ path: "/order_ids", strategy: "remove" }],
      hard_limits: { max_batch: 50 },
      risk_escalation: { max_batch: 10 },
      size_measures: { batch: { kind: "array_length", path: "/order_ids" } },
    });
    expect(notificationDeliveryBatchEnqueueCommand.invariants).toEqual(
      expect.arrayContaining(["rbac.customer_read", "rbac.notification_send"]),
    );
    for (const query of [
      notificationDeliveryCapabilityQuery,
      notificationDeliveryBatchesListQuery,
      notificationDeliveryBatchGetQuery,
    ]) {
      expect(query.offline_mode).toBe("denied");
    }
  });

  it("keeps capability truthful when no external provider exists", () => {
    expect(
      NotificationDeliveryCapabilityResultSchema.parse({
        state: "software_only",
        provider_code: "fake_sms",
        channels: { manual: "available", sms: "software_only", wechat: "disabled" },
        templates: [{ code: "pickup_reminder_v1", version: 1, channel: "sms" }],
        max_batch: 50,
        r4_threshold: 10,
        unit_cost_cents: 0,
        max_batch_cost_cents: 0,
      }),
    ).toMatchObject({ state: "software_only", provider_code: "fake_sms" });
    expect(() =>
      NotificationDeliveryCapabilityResultSchema.parse({
        state: "external",
        provider_code: null,
        channels: { manual: "available", sms: "external", wechat: "disabled" },
        templates: [],
        max_batch: 50,
        r4_threshold: 10,
        unit_cost_cents: null,
        max_batch_cost_cents: null,
      }),
    ).toThrow();
  });

  it("returns bounded status without phone, message, HMAC or provider payload fields", () => {
    const parsed = NotificationDeliveryBatchGetResultSchema.parse({
      batch: {
        batch_id: BATCH_ID,
        status: "attention_required",
        assurance: "software_only",
        provider_code: "fake_sms",
        channel: "sms",
        template_code: "pickup_reminder_v1",
        template_version: 1,
        recipient_count: 1,
        counts: {
          queued: 0,
          sending: 0,
          retry_wait: 0,
          accepted: 0,
          delivered: 0,
          manual_required: 1,
          cancelled: 0,
        },
        spent_cost_cents: 0,
        max_cost_cents: 0,
        created_at: AT,
        updated_at: AT,
      },
      deliveries: [
        {
          delivery_id: DELIVERY_ID,
          order_id: ORDER_ID,
          ticket_no: "T-1001",
          status: "manual_required",
          attempt_count: 5,
          next_attempt_at: null,
          last_error_code: "PROVIDER_RETRY_EXHAUSTED",
          cost_cents: 0,
          updated_at: AT,
        },
      ],
    });
    expect(JSON.stringify(parsed)).not.toMatch(/phone|message|hmac|payload/iu);
  });
});
