import { describe, expect, it } from "vitest";

import {
  DeliveryAppointmentCancelInputSchema,
  DeliveryAppointmentAddressesListResultSchema,
  DeliveryAppointmentCreateInputSchema,
  DeliveryAppointmentRescheduleInputSchema,
  DeliveryAppointmentsListInputSchema,
  M2_CONTRACT_COMMAND_NAMES,
  M2_CONTRACT_QUERY_NAMES,
  M2_READ_ONLY_AI_DEFINITIONS,
  deliveryAppointmentCancelCommand,
  deliveryAppointmentAddressesListQuery,
  deliveryAppointmentCreateCommand,
  deliveryAppointmentGetQuery,
  deliveryAppointmentRescheduleCommand,
  deliveryAppointmentsListQuery,
} from "../src/index.js";

const CUSTOMER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ADDRESS_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const APPOINTMENT_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("delivery appointment contracts", () => {
  it("freezes three R3 writes and two bounded PII reads outside AI", () => {
    expect(M2_CONTRACT_COMMAND_NAMES).toEqual(
      expect.arrayContaining([
        "delivery.appointment.create",
        "delivery.appointment.reschedule",
        "delivery.appointment.cancel",
      ]),
    );
    expect(M2_CONTRACT_QUERY_NAMES).toEqual(
      expect.arrayContaining([
        "delivery.appointment.get",
        "delivery.appointment.addresses.list",
        "delivery.appointments.list",
      ]),
    );
    for (const command of [
      deliveryAppointmentCreateCommand,
      deliveryAppointmentRescheduleCommand,
      deliveryAppointmentCancelCommand,
    ]) {
      expect(command).toMatchObject({
        risk: "R3",
        offline_mode: "denied",
        data_classification: "pii",
        idempotent: true,
      });
    }
    expect(deliveryAppointmentGetQuery).toMatchObject({
      risk: "R2",
      max_result_rows: 1,
      invariants: ["rbac.delivery_read"],
    });
    expect(deliveryAppointmentAddressesListQuery).toMatchObject({
      risk: "R2",
      max_result_rows: 100,
      invariants: ["rbac.delivery_read"],
    });
    expect(deliveryAppointmentsListQuery).toMatchObject({ risk: "R2", max_result_rows: 100 });
    const aiNames = M2_READ_ONLY_AI_DEFINITIONS.map(({ name }) => name);
    expect(aiNames).not.toContain("delivery.appointment.get");
    expect(aiNames).not.toContain("delivery.appointment.addresses.list");
    expect(aiNames).not.toContain("delivery.appointments.list");
  });

  it("accepts only server-scoped create fields and exact policy version", () => {
    const valid = {
      customer_id: CUSTOMER_ID,
      address_id: ADDRESS_ID,
      direction: "pickup",
      service_area_code: "north",
      requested_start_at: 1_800_000_000,
      expected_policy_version: 1,
    } as const;
    expect(DeliveryAppointmentCreateInputSchema.parse(valid)).toEqual(valid);
    for (const extra of [
      { org_id: CUSTOMER_ID },
      { store_id: ADDRESS_ID },
      { fee_cents: 100 },
      { max_appointments_per_slot: 3 },
      { address: "private" },
    ]) {
      expect(DeliveryAppointmentCreateInputSchema.safeParse({ ...valid, ...extra }).success).toBe(
        false,
      );
    }
    expect(
      DeliveryAppointmentCreateInputSchema.safeParse({ ...valid, expected_policy_version: 0 })
        .success,
    ).toBe(false);
  });

  it("requires optimistic lifecycle versions and controlled cancellation reasons", () => {
    expect(
      DeliveryAppointmentRescheduleInputSchema.parse({
        appointment_id: APPOINTMENT_ID,
        customer_id: CUSTOMER_ID,
        expected_version: 2,
        expected_policy_version: 3,
        requested_start_at: 1_800_003_600,
      }),
    ).toBeDefined();
    expect(
      DeliveryAppointmentCancelInputSchema.parse({
        appointment_id: APPOINTMENT_ID,
        customer_id: CUSTOMER_ID,
        expected_version: 2,
        reason: "customer_request",
      }),
    ).toBeDefined();
    expect(
      DeliveryAppointmentCancelInputSchema.safeParse({
        appointment_id: APPOINTMENT_ID,
        customer_id: CUSTOMER_ID,
        expected_version: 2,
        reason: "free text with private detail",
      }).success,
    ).toBe(false);
  });

  it("bounds and orders list filters", () => {
    expect(DeliveryAppointmentsListInputSchema.parse({})).toEqual({});
    expect(
      DeliveryAppointmentsListInputSchema.safeParse({ from_start_at: 20, to_start_at: 10 }).success,
    ).toBe(false);
    expect(DeliveryAppointmentsListInputSchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it("bounds the canonical active-address projection and rejects extra PII", () => {
    const address = {
      address_id: ADDRESS_ID,
      label: "家",
      address: "合成测试地址",
      is_default: true,
    } as const;
    expect(
      DeliveryAppointmentAddressesListResultSchema.parse({
        customer_id: CUSTOMER_ID,
        addresses: [address],
      }),
    ).toEqual({ customer_id: CUSTOMER_ID, addresses: [address] });
    expect(
      DeliveryAppointmentAddressesListResultSchema.safeParse({
        customer_id: CUSTOMER_ID,
        addresses: [{ ...address, contact_phone: "13800000000" }],
      }).success,
    ).toBe(false);
    expect(
      DeliveryAppointmentAddressesListResultSchema.safeParse({
        customer_id: CUSTOMER_ID,
        addresses: Array.from({ length: 101 }, () => address),
      }).success,
    ).toBe(false);
  });
});
