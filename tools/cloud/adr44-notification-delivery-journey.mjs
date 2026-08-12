import {
  asRecord,
  requireInteger,
  requireString,
  requireThat,
  requireUuid,
} from "./adr36-web-core.mjs";

const SYNTHETIC_ORDER_ID = "99999999-9999-4999-8999-999999999999";
const BATCH_STATUSES = new Set([
  "queued",
  "processing",
  "completed",
  "attention_required",
  "cancelled",
]);
const DELIVERY_STATUSES = new Set([
  "queued",
  "sending",
  "retry_wait",
  "accepted",
  "delivered",
  "manual_required",
  "cancelled",
]);
const COUNT_KEYS = Object.freeze([
  "accepted",
  "cancelled",
  "delivered",
  "manual_required",
  "queued",
  "retry_wait",
  "sending",
]);
const BATCH_KEYS = Object.freeze([
  "assurance",
  "batch_id",
  "channel",
  "counts",
  "created_at",
  "max_cost_cents",
  "provider_code",
  "recipient_count",
  "spent_cost_cents",
  "status",
  "template_code",
  "template_version",
  "updated_at",
]);
const DELIVERY_KEYS = Object.freeze([
  "attempt_count",
  "cost_cents",
  "delivery_id",
  "last_error_code",
  "next_attempt_at",
  "order_id",
  "status",
  "ticket_no",
  "updated_at",
]);
const FORBIDDEN_KEY = /(?:phone|message|body|hmac|payload|secret|token|provider_ref)/iu;

function exactKeys(record, keys, code) {
  const actual = Object.keys(record).sort();
  requireThat(
    actual.length === keys.length && actual.every((key, index) => key === keys[index]),
    code,
  );
}

function validTimestamp(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function assertNoForbiddenKeys(value) {
  if (Array.isArray(value)) {
    value.forEach(assertNoForbiddenKeys);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, entry] of Object.entries(value)) {
    requireThat(!FORBIDDEN_KEY.test(key), "NOTIFICATION_DELIVERY_PII_FIELD_PRESENT");
    assertNoForbiddenKeys(entry);
  }
}

function readCapability(value) {
  const capability = asRecord(value, "NOTIFICATION_CAPABILITY_INVALID");
  exactKeys(
    capability,
    [
      "channels",
      "max_batch",
      "max_batch_cost_cents",
      "provider_code",
      "r4_threshold",
      "state",
      "templates",
      "unit_cost_cents",
    ],
    "NOTIFICATION_CAPABILITY_INVALID",
  );
  const channels = asRecord(capability.channels, "NOTIFICATION_CAPABILITY_INVALID");
  exactKeys(channels, ["manual", "sms", "wechat"], "NOTIFICATION_CAPABILITY_INVALID");
  requireThat(
    capability.max_batch === 50 &&
      capability.r4_threshold === 10 &&
      channels.manual === "available" &&
      channels.wechat === "disabled" &&
      Array.isArray(capability.templates),
    "NOTIFICATION_CAPABILITY_INVALID",
  );
  if (capability.state === "disabled") {
    requireThat(
      capability.provider_code === null &&
        channels.sms === "disabled" &&
        capability.templates.length === 0 &&
        capability.unit_cost_cents === null &&
        capability.max_batch_cost_cents === null,
      "NOTIFICATION_CAPABILITY_INVALID",
    );
    return "disabled";
  }
  requireThat(
    capability.state === "software_only" &&
      capability.provider_code === "software_only_fake" &&
      channels.sms === "software_only" &&
      capability.unit_cost_cents === 0 &&
      capability.max_batch_cost_cents === 0 &&
      capability.templates.length === 1,
    "NOTIFICATION_EXTERNAL_PROVIDER_UNPROVEN",
  );
  const template = asRecord(capability.templates[0], "NOTIFICATION_CAPABILITY_INVALID");
  exactKeys(template, ["channel", "code", "version"], "NOTIFICATION_CAPABILITY_INVALID");
  requireThat(
    template.channel === "sms" &&
      template.code === "pickup_reminder_v1" &&
      requireInteger(template.version, "NOTIFICATION_CAPABILITY_INVALID") > 0,
    "NOTIFICATION_CAPABILITY_INVALID",
  );
  return "software_only";
}

function readBatch(value) {
  const batch = asRecord(value, "NOTIFICATION_BATCH_INVALID");
  exactKeys(batch, BATCH_KEYS, "NOTIFICATION_BATCH_INVALID");
  const counts = asRecord(batch.counts, "NOTIFICATION_BATCH_INVALID");
  exactKeys(counts, COUNT_KEYS, "NOTIFICATION_BATCH_INVALID");
  const count = COUNT_KEYS.reduce(
    (sum, key) => sum + requireInteger(counts[key], "NOTIFICATION_BATCH_INVALID"),
    0,
  );
  const recipientCount = requireInteger(batch.recipient_count, "NOTIFICATION_BATCH_INVALID");
  requireThat(
    requireUuid(batch.batch_id, "NOTIFICATION_BATCH_INVALID") === batch.batch_id &&
      BATCH_STATUSES.has(batch.status) &&
      batch.assurance === "software_only" &&
      batch.provider_code === "software_only_fake" &&
      batch.channel === "sms" &&
      batch.template_code === "pickup_reminder_v1" &&
      requireInteger(batch.template_version, "NOTIFICATION_BATCH_INVALID") > 0 &&
      recipientCount > 0 &&
      recipientCount <= 50 &&
      count === recipientCount &&
      batch.spent_cost_cents === 0 &&
      batch.max_cost_cents === 0 &&
      validTimestamp(batch.created_at) &&
      validTimestamp(batch.updated_at),
    "NOTIFICATION_BATCH_INVALID",
  );
  return batch;
}

function readDelivery(value) {
  const delivery = asRecord(value, "NOTIFICATION_DELIVERY_INVALID");
  exactKeys(delivery, DELIVERY_KEYS, "NOTIFICATION_DELIVERY_INVALID");
  requireThat(
    requireUuid(delivery.delivery_id, "NOTIFICATION_DELIVERY_INVALID") === delivery.delivery_id &&
      requireUuid(delivery.order_id, "NOTIFICATION_DELIVERY_INVALID") === delivery.order_id &&
      requireString(delivery.ticket_no, "NOTIFICATION_DELIVERY_INVALID").length <= 64 &&
      DELIVERY_STATUSES.has(delivery.status) &&
      requireInteger(delivery.attempt_count, "NOTIFICATION_DELIVERY_INVALID") <= 5 &&
      delivery.cost_cents === 0 &&
      (delivery.next_attempt_at === null || validTimestamp(delivery.next_attempt_at)) &&
      (delivery.last_error_code === null ||
        /^[A-Z][A-Z0-9_]{0,63}$/u.test(delivery.last_error_code)) &&
      validTimestamp(delivery.updated_at),
    "NOTIFICATION_DELIVERY_INVALID",
  );
  return delivery;
}

export async function notificationDeliveryBoundaryJourney(api, context) {
  requireThat(typeof api?.query === "function", "NOTIFICATION_DELIVERY_API_INVALID");
  requireThat(typeof api?.expectCommandFailure === "function", "NOTIFICATION_DELIVERY_API_INVALID");
  const session = asRecord(context?.session, "NOTIFICATION_DELIVERY_CONTEXT_INVALID");
  const state = readCapability(
    await api.query(session, "notification.delivery.capability.get", {}),
  );
  await api.expectCommandFailure(
    session,
    "notification.delivery_batch.enqueue",
    {
      order_ids: [SYNTHETIC_ORDER_ID],
      channel: "sms",
      template_code: "pickup_reminder_v1",
      max_cost_cents: 0,
      min_age_days: 30,
      unpaid_only: true,
      garment_statuses: ["ready"],
      customer_phone: "19900000000",
    },
    "VALIDATION_FAILED",
  );
  if (state === "disabled") {
    return Object.freeze({
      state,
      assurance: "blocked_external_provider",
      observedBatches: 0,
      observedDeliveries: 0,
    });
  }

  const listed = asRecord(
    await api.query(session, "notification.delivery_batches.list", { limit: 5 }),
    "NOTIFICATION_BATCH_LIST_INVALID",
  );
  exactKeys(listed, ["batches"], "NOTIFICATION_BATCH_LIST_INVALID");
  requireThat(
    Array.isArray(listed.batches) && listed.batches.length <= 5,
    "NOTIFICATION_BATCH_LIST_INVALID",
  );
  assertNoForbiddenKeys(listed);
  const batches = listed.batches.map(readBatch);
  let observedDeliveries = 0;
  for (const batch of batches) {
    const detail = asRecord(
      await api.query(session, "notification.delivery_batch.get", { batch_id: batch.batch_id }),
      "NOTIFICATION_BATCH_DETAIL_INVALID",
    );
    exactKeys(detail, ["batch", "deliveries"], "NOTIFICATION_BATCH_DETAIL_INVALID");
    assertNoForbiddenKeys(detail);
    const detailBatch = readBatch(detail.batch);
    requireThat(detailBatch.batch_id === batch.batch_id, "NOTIFICATION_BATCH_DETAIL_INVALID");
    requireThat(
      Array.isArray(detail.deliveries) && detail.deliveries.length === batch.recipient_count,
      "NOTIFICATION_BATCH_DETAIL_INVALID",
    );
    detail.deliveries.forEach(readDelivery);
    observedDeliveries += detail.deliveries.length;
  }
  return Object.freeze({
    state,
    assurance: "software_only",
    observedBatches: batches.length,
    observedDeliveries,
  });
}
