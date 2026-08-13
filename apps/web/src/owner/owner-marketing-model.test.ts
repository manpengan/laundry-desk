import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMarketingCampaignInput,
  campaignToDraft,
  emptyMarketingDraft,
  parseAudiencePreview,
  parseCampaignList,
} from "./owner-marketing-model.js";

const CAMPAIGN = Object.freeze({
  campaign_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  code: "summer_26",
  name: "夏季回访",
  status: "draft" as const,
  starts_at: "2026-08-14T00:00:00.000Z",
  ends_at: "2026-09-14T00:00:00.000Z",
  budget_limit_cents: 50_025,
  budget_used_cents: 0,
  budget_remaining_cents: 50_025,
  recipient_limit: 100,
  audience_rule: Object.freeze({
    customer_age: Object.freeze({ kind: "any" as const }),
    order_activity: Object.freeze({ kind: "none" as const }),
    membership: Object.freeze({
      kind: "tiers" as const,
      tier_ids: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    }),
  }),
  audience_rule_sha256: "a".repeat(64),
  version: 1,
  updated_at: "2026-08-13T02:00:00.000Z",
});

test("marketing editor converts decimal yuan to integer cents without floating authority", () => {
  const draft = Object.freeze({
    ...campaignToDraft(CAMPAIGN),
    campaignId: undefined,
    expectedVersion: 0,
    budgetYuan: "500.25",
  });
  const built = buildMarketingCampaignInput(draft);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.equal(built.input.budget_limit_cents, 50_025);
  assert.equal(Object.hasOwn(built.input, "campaign_id"), false);
  assert.deepEqual(built.input.audience_rule.membership, CAMPAIGN.audience_rule.membership);

  assert.equal(buildMarketingCampaignInput({ ...draft, budgetYuan: "1.001" }).ok, false);
  assert.equal(buildMarketingCampaignInput({ ...draft, recipientLimit: "501" }).ok, false);
});

test("marketing model accepts aggregate-only results and rejects recipient leakage", () => {
  const listed = parseCampaignList({ result: { campaigns: [CAMPAIGN] } });
  assert.equal(listed?.length, 1);
  const preview = {
    campaign_id: CAMPAIGN.campaign_id,
    campaign_version: 1,
    audience_rule_sha256: "a".repeat(64),
    audience_digest: "b".repeat(64),
    recipient_count: 1,
    matched_count: 2,
    truncated: true,
    evaluated_at: "2026-08-13T02:00:00.000Z",
  };
  assert.equal(parseAudiencePreview({ result: preview })?.recipient_count, 1);
  assert.equal(
    parseAudiencePreview({ result: { ...preview, customer_ids: [CAMPAIGN.campaign_id] } }),
    null,
  );
});

test("new campaign defaults are bounded and require an explicit code and name", () => {
  const draft = emptyMarketingDraft(new Date("2026-08-13T02:00:00.000Z"));
  assert.equal(draft.expectedVersion, 0);
  assert.equal(draft.recipientLimit, "100");
  assert.equal(buildMarketingCampaignInput(draft).ok, false);
});
