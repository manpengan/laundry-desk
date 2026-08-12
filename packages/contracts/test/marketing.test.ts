import { describe, expect, it } from "vitest";

import {
  MARKETING_COMMANDS,
  MARKETING_QUERIES,
  MarketingCampaignAudienceFreezeInputSchema,
  MarketingCampaignSetInputSchema,
} from "../src/commands/marketing.js";
import {
  MarketingAudienceFreezeConfirmationSummarySchema,
  MarketingCampaignSetConfirmationSummarySchema,
} from "../src/envelope/marketing-campaign-confirmation.js";

const base = Object.freeze({
  expected_version: 0,
  code: "summer_26",
  name: "夏季回访",
  status: "draft",
  starts_at: "2026-08-14T00:00:00.000Z",
  ends_at: "2026-09-14T00:00:00.000Z",
  budget_limit_cents: 50_000,
  recipient_limit: 100,
  audience_rule: Object.freeze({
    customer_age: Object.freeze({ kind: "within_days", days: 90 }),
    order_activity: Object.freeze({ kind: "none" }),
    membership: Object.freeze({ kind: "non_member" }),
  }),
});

describe("ADR-52 marketing contracts", () => {
  it("accepts only the bounded whitelist DSL and exact window/budget shape", () => {
    expect(MarketingCampaignSetInputSchema.parse(base)).toMatchObject(base);
    expect(() =>
      MarketingCampaignSetInputSchema.parse({
        ...base,
        audience_rule: { ...base.audience_rule, raw_sql: "TRUE" },
      }),
    ).toThrow();
    expect(() =>
      MarketingCampaignSetInputSchema.parse({
        ...base,
        audience_rule: {
          ...base.audience_rule,
          customer_age: { kind: "within_days", days: 90, extra: true },
        },
      }),
    ).toThrow();
    expect(() =>
      MarketingCampaignSetInputSchema.parse({
        ...base,
        ends_at: "2029-09-14T00:00:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      MarketingCampaignSetInputSchema.parse({
        ...base,
        campaign_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    ).toThrow();
    expect(() =>
      MarketingCampaignSetInputSchema.parse({ ...base, budget_limit_cents: 50_000.5 }),
    ).toThrow();
    expect(() =>
      MarketingCampaignSetInputSchema.parse({ ...base, recipient_limit: 501 }),
    ).toThrow();
    expect(() =>
      MarketingCampaignSetInputSchema.parse({
        ...base,
        audience_rule: {
          ...base.audience_rule,
          membership: {
            kind: "tiers",
            tier_ids: [
              "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            ],
          },
        },
      }),
    ).toThrow();
  });

  it("freezes digest-only authority and keeps every surface internal and online", () => {
    expect(
      MarketingCampaignAudienceFreezeInputSchema.parse({
        campaign_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        expected_version: 1,
        preview_digest: "a".repeat(64),
        expected_recipient_count: 0,
      }),
    ).not.toHaveProperty("customer_ids");
    expect(MARKETING_COMMANDS.map((definition) => definition.name)).toEqual([
      "marketing.campaign.set",
      "marketing.campaign.audience.freeze",
    ]);
    expect(MARKETING_QUERIES.map((definition) => definition.name)).toEqual([
      "marketing.campaigns.list",
      "marketing.campaign.get",
      "marketing.campaign.audience.preview",
    ]);
    expect(
      [...MARKETING_COMMANDS, ...MARKETING_QUERIES].every(
        (definition) => definition.offline_mode === "denied",
      ),
    ).toBe(true);
    expect(MARKETING_COMMANDS[0]).toMatchObject({
      risk: "R3",
      hard_limits: { max_amount_cents: 5_000_000 },
      risk_escalation: { max_amount_cents: 500_000 },
    });
  });

  it("requires complete exact-key WYSIWYS summaries for both campaign commands", () => {
    expect(
      MarketingCampaignSetConfirmationSummarySchema.parse({
        kind: "marketing_campaign_set",
        ...base,
      }),
    ).toMatchObject({ budget_limit_cents: 50_000, recipient_limit: 100 });
    expect(() =>
      MarketingCampaignSetConfirmationSummarySchema.parse({
        kind: "marketing_campaign_set",
        ...base,
        hidden_override: true,
      }),
    ).toThrow();
    const freeze = {
      kind: "marketing_audience_freeze",
      campaign_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      campaign_code: "summer_26",
      campaign_name: "夏季回访",
      campaign_version: 2,
      audience_rule_sha256: "a".repeat(64),
      audience_digest: "b".repeat(64),
      recipient_count: 12,
    };
    expect(MarketingAudienceFreezeConfirmationSummarySchema.parse(freeze)).toEqual(freeze);
    expect(() =>
      MarketingAudienceFreezeConfirmationSummarySchema.parse({
        ...freeze,
        customer_ids: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
      }),
    ).toThrow();
  });
});
