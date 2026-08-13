import assert from "node:assert/strict";
import test from "node:test";

import {
  createMarketingRequestToken,
  createMarketingPendingAuthority,
  marketingAuthorityKey,
  marketingRequestMatches,
  readMarketingCampaignSummary,
} from "./marketing-campaign-authority.js";

const SET_REQUEST = Object.freeze({
  action: "marketing.campaign.set" as const,
  input: Object.freeze({
    expected_version: 0,
    code: "summer_26",
    name: "夏季回访",
    status: "draft" as const,
    starts_at: "2026-08-14T00:00:00.000Z",
    ends_at: "2026-09-14T00:00:00.000Z",
    budget_limit_cents: 50_000,
    recipient_limit: 100,
    audience_rule: Object.freeze({
      customer_age: Object.freeze({ kind: "any" as const }),
      order_activity: Object.freeze({ kind: "none" as const }),
      membership: Object.freeze({ kind: "non_member" as const }),
    }),
  }),
});

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return Object.freeze({ promise, resolve: resolvePromise });
}

test("old marketing responses cannot cross an input generation or session scope", async () => {
  const key = marketingAuthorityKey(SET_REQUEST);
  const token = createMarketingRequestToken(3, "session-a", key);
  const response = deferred<string>();
  const accepted = response.promise.then((value) =>
    marketingRequestMatches(token, 4, "session-a", key) ? value : null,
  );
  response.resolve("stale");
  assert.equal(await accepted, null);
  assert.equal(marketingRequestMatches(token, 3, "session-b", key), false);
  assert.equal(
    marketingRequestMatches(
      token,
      3,
      "session-a",
      marketingAuthorityKey({
        ...SET_REQUEST,
        input: { ...SET_REQUEST.input, budget_limit_cents: 50_001 },
      }),
    ),
    false,
  );
});

test("confirmation summaries must match the originating immutable request", () => {
  const summary = Object.freeze({ kind: "marketing_campaign_set" as const, ...SET_REQUEST.input });
  assert.deepEqual(readMarketingCampaignSummary(SET_REQUEST, summary), summary);
  assert.equal(
    readMarketingCampaignSummary(SET_REQUEST, { ...summary, budget_limit_cents: 50_001 }),
    null,
  );
  const freezeRequest = Object.freeze({
    action: "marketing.campaign.audience.freeze" as const,
    input: Object.freeze({
      campaign_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expected_version: 2,
      preview_digest: "b".repeat(64),
      expected_recipient_count: 12,
    }),
  });
  const freeze = Object.freeze({
    kind: "marketing_audience_freeze" as const,
    campaign_id: freezeRequest.input.campaign_id,
    campaign_code: "summer_26",
    campaign_name: "夏季回访",
    campaign_version: 2,
    audience_rule_sha256: "a".repeat(64),
    audience_digest: "b".repeat(64),
    recipient_count: 12,
  });
  assert.deepEqual(readMarketingCampaignSummary(freezeRequest, freeze), freeze);
  assert.equal(
    readMarketingCampaignSummary(freezeRequest, { ...freeze, recipient_count: 11 }),
    null,
  );
});

test("marketing confirmation submit binds scope, full authority and action generation", () => {
  const authority = createMarketingPendingAuthority();
  const pending = Object.freeze({
    request: SET_REQUEST,
    confirmRef: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    stepUp: true,
    actionGeneration: 7,
    summary: Object.freeze({ kind: "marketing_campaign_set" as const, ...SET_REQUEST.input }),
  });
  authority.begin(pending, "scope-a");
  const token = authority.currentStepUp();
  assert.notEqual(token, null);
  if (token === null) return;
  assert.equal(authority.matches(pending, "scope-a", 7, token), true);
  assert.equal(authority.matches(pending, "scope-b", 7, token), false);
  assert.equal(authority.matches(pending, "scope-a", 8, token), false);
  assert.equal(
    authority.matches(
      Object.freeze({
        ...pending,
        summary: Object.freeze({ ...pending.summary, budget_limit_cents: 50_001 }),
      }),
      "scope-a",
      7,
      token,
    ),
    false,
  );
  authority.invalidate();
  assert.equal(authority.matches(pending, "scope-a", 7, token), false);
});
