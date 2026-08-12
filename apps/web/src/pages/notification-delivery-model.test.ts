import assert from "node:assert/strict";
import test from "node:test";

import type {
  NotificationDeliveryBatchGetResult,
  NotificationDeliveryCapabilityResult,
  NotificationDeliveryStatus,
} from "@laundry/contracts";

import {
  buildNotificationEnqueueInput,
  manualFallbackOrderIds,
  notificationAcceptedCountLabel,
  notificationCapabilityCopy,
  notificationDeliveredCountLabel,
  notificationDeliveryStatusLabel,
  parseNotificationBatchDetail,
  parseNotificationBatchList,
  parseNotificationCapability,
} from "./notification-delivery-model.js";

const ORDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BATCH_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DELIVERY_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AT = "2026-08-12T01:02:03.000Z";

const SOFTWARE_CAPABILITY: NotificationDeliveryCapabilityResult = {
  state: "software_only",
  provider_code: "software_only_fake",
  channels: { manual: "available", sms: "software_only", wechat: "disabled" },
  templates: [{ code: "pickup_reminder_v1", version: 1, channel: "sms" }],
  max_batch: 50,
  r4_threshold: 10,
  unit_cost_cents: 0,
  max_batch_cost_cents: 0,
};

function batchDetail(status: NotificationDeliveryStatus): NotificationDeliveryBatchGetResult {
  return {
    batch: {
      batch_id: BATCH_ID,
      status: status === "manual_required" ? "attention_required" : "processing",
      assurance: "software_only",
      provider_code: "software_only_fake",
      channel: "sms",
      template_code: "pickup_reminder_v1",
      template_version: 1,
      recipient_count: 1,
      counts: {
        queued: status === "queued" ? 1 : 0,
        sending: status === "sending" ? 1 : 0,
        retry_wait: status === "retry_wait" ? 1 : 0,
        accepted: status === "accepted" ? 1 : 0,
        delivered: status === "delivered" ? 1 : 0,
        manual_required: status === "manual_required" ? 1 : 0,
        cancelled: status === "cancelled" ? 1 : 0,
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
        ticket_no: "E2E-0001",
        status,
        attempt_count: status === "queued" ? 0 : 1,
        next_attempt_at: status === "retry_wait" ? AT : null,
        last_error_code: status === "manual_required" ? "PROVIDER_REJECTED" : null,
        cost_cents: 0,
        updated_at: AT,
      },
    ],
  };
}

test("capability parser distinguishes disabled and software-only without delivery claims", () => {
  const parsed = parseNotificationCapability({ result: SOFTWARE_CAPABILITY });
  assert.equal(parsed?.state, "software_only");
  assert.equal(
    parseNotificationCapability({ result: { ...SOFTWARE_CAPABILITY, extra: true } }),
    null,
  );

  const copy = notificationCapabilityCopy(SOFTWARE_CAPABILITY);
  assert.match(copy.title, /软件模拟/u);
  for (const status of [
    "queued",
    "sending",
    "retry_wait",
    "accepted",
    "delivered",
    "manual_required",
    "cancelled",
  ] as const) {
    const visible = `${copy.title} ${copy.description} ${notificationDeliveryStatusLabel(
      status,
      "software_only",
    )}`;
    assert.doesNotMatch(visible, /已发送|送达|通知成功/u);
  }
});

test("delivered counters preserve the configured assurance boundary", () => {
  const softwareLabel = notificationDeliveredCountLabel("software_only");
  const softwareAccepted = notificationAcceptedCountLabel("software_only");
  assert.equal(softwareLabel, "软件模拟完成");
  assert.equal(softwareAccepted, "软件模拟已接单");
  assert.doesNotMatch(softwareLabel, /回执|送达|已发送/u);
  assert.doesNotMatch(softwareAccepted, /通道|送达|已发送/u);
  assert.equal(notificationDeliveredCountLabel("external"), "回执确认");
  assert.equal(notificationAcceptedCountLabel("external"), "通道已接单");
});

test("enqueue input freezes only server-approved references, filters and exact zero cost", () => {
  const input = buildNotificationEnqueueInput(
    [ORDER_ID],
    { minAgeDays: 90, unpaidOnly: true, statuses: ["racked"] },
    SOFTWARE_CAPABILITY,
  );
  assert.deepEqual(input, {
    order_ids: [ORDER_ID],
    channel: "sms",
    template_code: "pickup_reminder_v1",
    max_cost_cents: 0,
    min_age_days: 90,
    unpaid_only: true,
    garment_statuses: ["racked"],
  });
  assert.doesNotMatch(JSON.stringify(input), /phone|message|provider_url|secret/iu);
  assert.equal(
    buildNotificationEnqueueInput(
      [ORDER_ID],
      { minAgeDays: 90, unpaidOnly: false, statuses: ["ready"] },
      {
        ...SOFTWARE_CAPABILITY,
        unit_cost_cents: 1,
      },
    ),
    null,
  );
});

test("batch parsers reject widened rows and expose only manual-required order references", () => {
  const detail = batchDetail("manual_required");
  const parsed = parseNotificationBatchDetail({ result: detail });
  assert.ok(parsed);
  assert.deepEqual(manualFallbackOrderIds(parsed), [ORDER_ID]);
  assert.equal(
    parseNotificationBatchDetail({
      result: {
        ...detail,
        deliveries: [{ ...detail.deliveries[0], customer_phone: "13800000000" }],
      },
    }),
    null,
  );
  assert.deepEqual(parseNotificationBatchList({ result: { batches: [detail.batch] } }), [
    detail.batch,
  ]);
});
