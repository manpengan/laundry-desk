import assert from "node:assert/strict";
import test from "node:test";

import type { DeliveryAvailabilityQuoteInput } from "@laundry/contracts";

import { evaluateDeliveryAvailability } from "./quote.js";
import { freezeDeliveryPolicy, type StoreDeliveryPolicy } from "./types.js";

const REQUESTED = Math.floor(Date.parse("2026-01-05T01:00:00.000Z") / 1_000);
const NOW = Math.floor(Date.parse("2026-01-04T00:00:00.000Z") / 1_000);

function policy(patch: Partial<StoreDeliveryPolicy> = {}): StoreDeliveryPolicy {
  return freezeDeliveryPolicy({
    version: 1,
    accepting_appointments: true,
    minimum_lead_minutes: 120,
    maximum_advance_days: 14,
    slot_minutes: 60,
    max_appointments_per_slot: 3,
    service_areas: [{ code: "north", name: "北区", fee_cents: 800, is_active: true }],
    weekly_windows: [{ weekday: 1, start_minute: 540, end_minute: 1_020 }],
    updated_at: NOW,
    ...patch,
  });
}

function request(patch: Partial<DeliveryAvailabilityQuoteInput> = {}) {
  return Object.freeze({
    direction: "pickup" as const,
    service_area_code: "north",
    requested_start_at: REQUESTED,
    ...patch,
  });
}

function evaluate(overrides: Partial<Parameters<typeof evaluateDeliveryAvailability>[0]> = {}) {
  return evaluateDeliveryAvailability({
    request: request(),
    policy: policy(),
    featureEnabled: true,
    timezone: "Asia/Taipei",
    nowEpochSeconds: NOW,
    ...overrides,
  });
}

test("policy-only quote returns fee and explicit unchecked capacity for an aligned slot", () => {
  const quote = evaluate({});

  assert.deepEqual(quote, {
    policy_version: 1,
    feature_enabled: true,
    can_request_appointment: true,
    reason: "available",
    direction: "pickup",
    service_area_code: "north",
    requested_start_at: REQUESTED,
    requested_end_at: REQUESTED + 3_600,
    fee_cents: 800,
    capacity_status: "not_checked",
    max_appointments_per_slot: 3,
    timezone: "Asia/Taipei",
  });
});

test("delivery feature-off wins before configured policy and fails closed", () => {
  const quote = evaluate({ featureEnabled: false });

  assert.equal(quote.reason, "delivery_disabled");
  assert.equal(quote.feature_enabled, false);
  assert.equal(quote.can_request_appointment, false);
  assert.equal(quote.fee_cents, null);
  assert.equal(quote.requested_end_at, null);
  assert.equal(quote.max_appointments_per_slot, null);
});

test("quote distinguishes unconfigured, paused, area, horizon, window and alignment failures", () => {
  const cases = [
    ["policy_not_configured", { policy: { ...policy(), version: 0 } }],
    ["appointments_paused", { policy: { ...policy(), accepting_appointments: false } }],
    ["service_area_unavailable", { request: request({ service_area_code: "south" }) }],
    ["outside_booking_horizon", { nowEpochSeconds: REQUESTED - 60 }],
    ["outside_service_window", { request: request({ requested_start_at: REQUESTED + 9 * 3_600 }) }],
    ["slot_misaligned", { request: request({ requested_start_at: REQUESTED + 1_800 }) }],
  ] as const;

  for (const [reason, overrides] of cases) {
    const quote = evaluate(overrides);
    assert.equal(quote.reason, reason);
    assert.equal(quote.can_request_appointment, false);
    assert.equal(quote.capacity_status, "not_checked");
  }
});

test("policy validation rejects overlapping or partial-slot windows", () => {
  assert.throws(
    () =>
      policy({
        weekly_windows: [
          { weekday: 1, start_minute: 540, end_minute: 660 },
          { weekday: 1, start_minute: 600, end_minute: 720 },
        ],
      }),
    /cannot overlap/iu,
  );
  assert.throws(
    () => policy({ weekly_windows: [{ weekday: 1, start_minute: 540, end_minute: 650 }] }),
    /whole appointment slots/iu,
  );
});
