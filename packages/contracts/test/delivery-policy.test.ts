import {
  DeliveryAvailabilityQuoteInputSchema,
  DeliveryPolicyConfirmationSummarySchema,
  DeliveryPolicySetInputSchema,
  M2_CONTRACT_COMMAND_NAMES,
  M2_CONTRACT_QUERY_NAMES,
  M2_READ_ONLY_AI_DEFINITIONS,
  deliveryAvailabilityQuoteQuery,
  deliveryPolicyGetQuery,
  deliveryPolicySetCommand,
  parseContractInput,
} from "../src/index.js";
import { describe, expect, it } from "vitest";

const VALID_POLICY = Object.freeze({
  expected_version: 0,
  accepting_appointments: true,
  minimum_lead_minutes: 120,
  maximum_advance_days: 14,
  slot_minutes: 60,
  max_appointments_per_slot: 3,
  service_areas: Object.freeze([
    Object.freeze({ code: "north", name: "北区", fee_cents: 800, is_active: true }),
  ]),
  weekly_windows: Object.freeze([
    Object.freeze({ weekday: 1, start_minute: 540, end_minute: 1_020 }),
  ]),
});

describe("delivery policy contracts", () => {
  it("registers one R5 command and two internal queries outside the AI projection", () => {
    expect(M2_CONTRACT_COMMAND_NAMES).toContain("delivery.policy.set");
    expect(M2_CONTRACT_QUERY_NAMES).toEqual(
      expect.arrayContaining(["delivery.policy.get", "delivery.availability.quote"]),
    );
    expect(deliveryPolicySetCommand).toMatchObject({
      risk: "R5",
      offline_mode: "denied",
      idempotent: true,
      invariants: ["rbac.settings_admin", "delivery.policy_version_matches"],
    });
    expect(deliveryPolicyGetQuery.invariants).toEqual(["rbac.settings_admin"]);
    expect(deliveryAvailabilityQuoteQuery).toMatchObject({
      risk: "R1",
      max_result_rows: 1,
      invariants: ["rbac.delivery_read"],
    });
    expect(M2_READ_ONLY_AI_DEFINITIONS.map(({ name }) => name)).not.toContain(
      "delivery.availability.quote",
    );
  });

  it("accepts bounded store policy fields and rejects duplicate areas or extra keys", async () => {
    await expect(parseContractInput(deliveryPolicySetCommand, VALID_POLICY)).resolves.toEqual(
      VALID_POLICY,
    );
    expect(
      DeliveryPolicySetInputSchema.safeParse({
        ...VALID_POLICY,
        service_areas: [...VALID_POLICY.service_areas, VALID_POLICY.service_areas[0]],
      }).success,
    ).toBe(false);
    expect(
      DeliveryPolicySetInputSchema.safeParse({ ...VALID_POLICY, delivery_enabled: true }).success,
    ).toBe(false);
    expect(
      DeliveryPolicySetInputSchema.safeParse({
        ...VALID_POLICY,
        weekly_windows: [{ weekday: 1, start_minute: 600, end_minute: 540 }],
      }).success,
    ).toBe(false);
  });

  it("keeps availability input free of customer identity and address fields", () => {
    const quote = {
      direction: "pickup",
      service_area_code: "north",
      requested_start_at: 1_800_000_000,
    } as const;
    expect(DeliveryAvailabilityQuoteInputSchema.parse(quote)).toEqual(quote);
    expect(
      DeliveryAvailabilityQuoteInputSchema.safeParse({
        ...quote,
        address: "private address",
      }).success,
    ).toBe(false);
    expect(
      DeliveryAvailabilityQuoteInputSchema.safeParse({
        ...quote,
        customer_id: "00000000-0000-4000-8000-000000000001",
      }).success,
    ).toBe(false);
  });

  it("freezes every policy field into the R5 confirmation summary", () => {
    const summary = DeliveryPolicyConfirmationSummarySchema.parse({
      kind: "delivery_policy",
      ...VALID_POLICY,
    });
    expect(summary).toEqual({ kind: "delivery_policy", ...VALID_POLICY });
    expect(
      DeliveryPolicyConfirmationSummarySchema.safeParse({
        ...summary,
        service_areas: summary.service_areas.map(({ code, name, is_active }) => ({
          code,
          name,
          is_active,
        })),
      }).success,
    ).toBe(false);
    expect(
      DeliveryPolicyConfirmationSummarySchema.safeParse({ ...summary, hidden_change: true })
        .success,
    ).toBe(false);
  });
});
