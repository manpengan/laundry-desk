import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_DELIVERY_POLICY_DRAFT,
  buildDeliveryPolicyInput,
  epochFromLocalDateTime,
  readDeliveryPolicy,
  readDeliveryQuote,
} from "./delivery-policy-model.js";

const POLICY = Object.freeze({
  version: 2,
  accepting_appointments: true,
  minimum_lead_minutes: 120,
  maximum_advance_days: 14,
  slot_minutes: 60,
  max_appointments_per_slot: 3,
  service_areas: Object.freeze([
    Object.freeze({ code: "north", name: "北区", fee_cents: 800, is_active: true }),
  ]),
  weekly_windows: Object.freeze([
    Object.freeze({ weekday: 1, start_minute: 540, end_minute: 1_440 }),
  ]),
  updated_at: 1_800_000_000,
});

test("delivery policy parser unwraps bus data and preserves 24:00", () => {
  const draft = readDeliveryPolicy({
    execution: "executed",
    result: { policy: POLICY },
  });
  assert.ok(draft);
  assert.equal(draft.version, 2);
  assert.equal(draft.service_areas[0]?.fee_text, "800");
  assert.equal(draft.weekly_windows[0]?.start_text, "09:00");
  assert.equal(draft.weekly_windows[0]?.end_text, "24:00");
});

test("delivery policy builder returns strict integer-cents input and checks schedule overlap", () => {
  const draft = readDeliveryPolicy({ policy: POLICY });
  assert.ok(draft);
  const built = buildDeliveryPolicyInput(draft);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(built.body, {
    expected_version: 2,
    accepting_appointments: true,
    minimum_lead_minutes: 120,
    maximum_advance_days: 14,
    slot_minutes: 60,
    max_appointments_per_slot: 3,
    service_areas: [{ code: "north", name: "北区", fee_cents: 800, is_active: true }],
    weekly_windows: [{ weekday: 1, start_minute: 540, end_minute: 1_440 }],
  });

  const overlap = buildDeliveryPolicyInput({
    ...draft,
    weekly_windows: [
      { row_id: "a", weekday: 1, start_text: "09:00", end_text: "12:00" },
      { row_id: "b", weekday: 1, start_text: "11:00", end_text: "14:00" },
    ],
  });
  assert.deepEqual(overlap, { ok: false, message: "同一天的服务时段不能重叠" });
});

test("accepting policy requires an active area and window", () => {
  const built = buildDeliveryPolicyInput({
    ...EMPTY_DELIVERY_POLICY_DRAFT,
    accepting_appointments: true,
  });
  assert.deepEqual(built, {
    ok: false,
    message: "开放预约前至少需要一个启用区域和一个服务时段",
  });
});

test("delivery quote parser keeps feature-off result and capacity disclaimer", () => {
  const quote = readDeliveryQuote({
    execution: "executed",
    result: {
      quote: {
        policy_version: 2,
        feature_enabled: false,
        can_request_appointment: false,
        reason: "delivery_disabled",
        direction: "pickup",
        service_area_code: "north",
        requested_start_at: 1_800_000_000,
        requested_end_at: null,
        fee_cents: null,
        capacity_status: "not_checked",
        max_appointments_per_slot: null,
        timezone: "Asia/Taipei",
      },
    },
  });
  assert.equal(quote?.reason, "delivery_disabled");
  assert.equal(quote?.capacity_status, "not_checked");
  assert.equal(readDeliveryQuote({ quote: { address: "private" } }), null);
});

test("local datetime conversion produces an integer-minute instant", () => {
  const epoch = epochFromLocalDateTime("2026-01-05T09:00");
  assert.equal(typeof epoch, "number");
  assert.equal((epoch ?? 1) % 60, 0);
  assert.equal(epochFromLocalDateTime("not-a-date"), null);
});
