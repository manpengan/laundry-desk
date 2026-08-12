import assert from "node:assert/strict";
import test from "node:test";

import { notificationDeliveryBoundaryJourney } from "./adr44-notification-delivery-journey.mjs";

const SESSION = Object.freeze({ staffId: "11111111-1111-4111-8111-111111111103" });
const BATCH_ID = "88888888-8888-4888-8888-888888888881";
const DELIVERY_ID = "88888888-8888-4888-8888-888888888882";
const ORDER_ID = "88888888-8888-4888-8888-888888888883";
const AT = "2026-08-12T00:00:00.000Z";

function capability(state) {
  const enabled = state === "software_only";
  return {
    state,
    provider_code: enabled ? "software_only_fake" : null,
    channels: { manual: "available", sms: state, wechat: "disabled" },
    templates: enabled ? [{ code: "pickup_reminder_v1", version: 1, channel: "sms" }] : [],
    max_batch: 50,
    r4_threshold: 10,
    unit_cost_cents: enabled ? 0 : null,
    max_batch_cost_cents: enabled ? 0 : null,
  };
}

const BATCH = Object.freeze({
  batch_id: BATCH_ID,
  status: "completed",
  assurance: "software_only",
  provider_code: "software_only_fake",
  channel: "sms",
  template_code: "pickup_reminder_v1",
  template_version: 1,
  recipient_count: 1,
  counts: {
    queued: 0,
    sending: 0,
    retry_wait: 0,
    accepted: 1,
    delivered: 0,
    manual_required: 0,
    cancelled: 0,
  },
  spent_cost_cents: 0,
  max_cost_cents: 0,
  created_at: AT,
  updated_at: AT,
});

function apiFor(state, widened = false) {
  const calls = [];
  return Object.freeze({
    calls,
    expectCommandFailure: async (_session, name, args, code) => {
      calls.push({ kind: "command", name, args, code });
    },
    query: async (_session, name) => {
      calls.push({ kind: "query", name });
      if (name === "notification.delivery.capability.get") return capability(state);
      if (name === "notification.delivery_batches.list") {
        return { batches: [{ ...BATCH, ...(widened ? { customer_phone: "19900000000" } : {}) }] };
      }
      if (name === "notification.delivery_batch.get") {
        return {
          batch: BATCH,
          deliveries: [
            {
              delivery_id: DELIVERY_ID,
              order_id: ORDER_ID,
              ticket_no: "SYNTHETIC-1",
              status: "accepted",
              attempt_count: 1,
              next_attempt_at: null,
              last_error_code: null,
              cost_cents: 0,
              updated_at: AT,
            },
          ],
        };
      }
      assert.fail(`unexpected query ${name}`);
    },
  });
}

test("disabled capability stays fail-closed and probes strict input without a write", async () => {
  const api = apiFor("disabled");
  const result = await notificationDeliveryBoundaryJourney(api, { session: SESSION });
  assert.deepEqual(result, {
    state: "disabled",
    assurance: "blocked_external_provider",
    observedBatches: 0,
    observedDeliveries: 0,
  });
  assert.equal(api.calls.filter((call) => call.kind === "query").length, 1);
  const command = api.calls.find((call) => call.kind === "command");
  assert.equal(command.name, "notification.delivery_batch.enqueue");
  assert.equal(command.code, "VALIDATION_FAILED");
  assert.equal(command.args.customer_phone, "19900000000");
});

test("software-only capability validates bounded safe batches and details", async () => {
  const api = apiFor("software_only");
  const result = await notificationDeliveryBoundaryJourney(api, { session: SESSION });
  assert.deepEqual(result, {
    state: "software_only",
    assurance: "software_only",
    observedBatches: 1,
    observedDeliveries: 1,
  });
  assert.doesNotMatch(JSON.stringify(result), /phone|message|payload|secret/iu);
});

test("unproven external capability and widened batch data fail closed", async () => {
  await assert.rejects(
    () => notificationDeliveryBoundaryJourney(apiFor("external"), { session: SESSION }),
    (error) => error?.code === "NOTIFICATION_EXTERNAL_PROVIDER_UNPROVEN",
  );
  await assert.rejects(
    () => notificationDeliveryBoundaryJourney(apiFor("software_only", true), { session: SESSION }),
    (error) => error?.code === "NOTIFICATION_DELIVERY_PII_FIELD_PRESENT",
  );
});
