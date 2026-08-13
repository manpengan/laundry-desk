import { describe, expect, it } from "vitest";

import {
  AUTOMATION_COMMANDS,
  AUTOMATION_QUERIES,
  AutomationPolicyCreateInputSchema,
} from "../src/commands/index.js";

const draft = Object.freeze({
  name: "超期取件提醒",
  tool: "notification.delivery_batch.enqueue" as const,
  object_filter: Object.freeze({
    min_age_days: 90 as const,
    unpaid_only: true,
    garment_statuses: Object.freeze(["ready", "racked"] as const),
    max_objects: 10,
  }),
  schedule: Object.freeze({
    cadence: "daily" as const,
    local_time: "10:00",
    days_of_week: Object.freeze([1, 2, 3, 4, 5]),
    window_start_local: "09:00",
    window_end_local: "11:00",
  }),
  limits: Object.freeze({ max_runs_per_day: 1, max_amount_cents: 1_000 }),
  valid_from: "2026-08-13T00:00:00.000Z",
  valid_until: null,
  reason: "减少长期滞留",
});

describe("bounded automation contracts", () => {
  it("accepts only the frozen tool, sorted windows and integer-fen bounds", () => {
    expect(AutomationPolicyCreateInputSchema.parse(draft)).toEqual(draft);
    expect(() =>
      AutomationPolicyCreateInputSchema.parse({ ...draft, tool: "order.refund" }),
    ).toThrow();
    expect(() =>
      AutomationPolicyCreateInputSchema.parse({
        ...draft,
        object_filter: { ...draft.object_filter, max_objects: 11 },
      }),
    ).toThrow();
    expect(() =>
      AutomationPolicyCreateInputSchema.parse({
        ...draft,
        schedule: { ...draft.schedule, local_time: "12:00" },
      }),
    ).toThrow();
    expect(() =>
      AutomationPolicyCreateInputSchema.parse({ ...draft, provider_url: "https://example.test" }),
    ).toThrow();
  });

  it("keeps management at R3 or below and exposes only fixed registry operations", () => {
    expect(AUTOMATION_COMMANDS.map((definition) => definition.name)).toEqual([
      "automation.policy.create",
      "automation.policy.update",
      "automation.policy.approve",
      "automation.policy.pause",
      "automation.policy.resume",
      "automation.policy.archive",
    ]);
    expect(
      AUTOMATION_COMMANDS.every(
        (definition) => definition.risk !== "R4" && definition.risk !== "R5",
      ),
    ).toBe(true);
    expect(
      AUTOMATION_COMMANDS.find((definition) => definition.name.endsWith("approve"))?.risk,
    ).toBe("R3");
    expect(AUTOMATION_QUERIES.map((definition) => definition.name)).toEqual([
      "automation.policies.list",
      "automation.policy.get",
      "automation.runs.list",
    ]);
  });
});
