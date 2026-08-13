import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDeliveryAppointmentCancel,
  buildDeliveryAppointmentCreate,
  buildDeliveryAppointmentReschedule,
  formatDeliveryFee,
  localDateTimeFromEpoch,
  parseDeliveryAppointmentAddresses,
  parseDeliveryAppointments,
} from "./delivery-appointment-model.js";

const APPOINTMENT = Object.freeze({
  appointment_id: "11111111-1111-4111-8111-111111111111",
  customer_id: "22222222-2222-4222-8222-222222222222",
  address_id: "33333333-3333-4333-8333-333333333333",
  direction: "pickup" as const,
  service_area_code: "north",
  scheduled_start_at: 1_800_000_000,
  scheduled_end_at: 1_800_003_600,
  fee_cents: 800,
  status: "scheduled" as const,
  version: 2,
  policy_version: 3,
  created_at: 1_799_000_000,
  updated_at: 1_799_000_100,
  cancelled_at: null,
  cancellation_reason: null,
});

test("appointment parser unwraps the bus envelope and rejects unknown fields", () => {
  const parsed = parseDeliveryAppointments({
    execution: "executed",
    result: { appointments: [APPOINTMENT] },
  });
  assert.deepEqual(parsed, [APPOINTMENT]);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed?.[0]), true);
  assert.equal(
    parseDeliveryAppointments({ appointments: [{ ...APPOINTMENT, raw_address: "不得进入预约" }] }),
    null,
  );
});

test("address parser accepts the canonical booking projection without contact fields", () => {
  const value = {
    customer_id: APPOINTMENT.customer_id,
    addresses: [
      {
        address_id: APPOINTMENT.address_id,
        label: "来源档案",
        address: "合成测试地址",
        is_default: false,
      },
    ],
  };
  assert.deepEqual(parseDeliveryAppointmentAddresses({ result: value }), value);
  assert.equal(
    parseDeliveryAppointmentAddresses({
      ...value,
      addresses: [{ ...value.addresses[0], contact_phone: "13800000000" }],
    }),
    null,
  );
});

test("create and reschedule builders submit strict ids, versions and absolute minutes", () => {
  const local = "2027-01-15T09:30";
  const expectedEpoch = Math.floor(new Date(local).getTime() / 1_000);
  const created = buildDeliveryAppointmentCreate(
    APPOINTMENT.customer_id,
    APPOINTMENT.address_id,
    "pickup",
    "north",
    local,
    3,
  );
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.deepEqual(created.body, {
    customer_id: APPOINTMENT.customer_id,
    address_id: APPOINTMENT.address_id,
    direction: "pickup",
    service_area_code: "north",
    requested_start_at: expectedEpoch,
    expected_policy_version: 3,
  });
  assert.equal("org_id" in created.body, false);
  assert.equal("address" in created.body, false);

  const rescheduled = buildDeliveryAppointmentReschedule(APPOINTMENT, local, 4);
  assert.equal(rescheduled.ok, true);
  if (!rescheduled.ok) return;
  assert.equal(rescheduled.body.expected_version, 2);
  assert.equal(rescheduled.body.expected_policy_version, 4);
  assert.equal(rescheduled.body.requested_start_at, expectedEpoch);
  assert.equal(buildDeliveryAppointmentReschedule(APPOINTMENT, "invalid", 4).ok, false);
});

test("cancel builder permits only controlled reasons and time formatter round-trips local minutes", () => {
  const cancelled = buildDeliveryAppointmentCancel(APPOINTMENT, "customer_request");
  assert.equal(cancelled.ok, true);
  if (!cancelled.ok) return;
  assert.deepEqual(cancelled.body, {
    appointment_id: APPOINTMENT.appointment_id,
    customer_id: APPOINTMENT.customer_id,
    expected_version: 2,
    reason: "customer_request",
  });
  assert.match(
    localDateTimeFromEpoch(APPOINTMENT.scheduled_start_at),
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u,
  );
  assert.equal(formatDeliveryFee(805), "¥8.05");
});
