import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  MarketingAudienceFreezeConfirmationDetails,
  MarketingCampaignSetConfirmationDetails,
} from "./MarketingCampaignConfirmationDetails.js";

test("campaign confirmation renders every mutable rule and financial field", () => {
  const html = renderToStaticMarkup(
    <MarketingCampaignSetConfirmationDetails
      summary={{
        kind: "marketing_campaign_set",
        campaign_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        expected_version: 3,
        code: "summer_26",
        name: "夏季回访",
        status: "scheduled",
        starts_at: "2026-08-14T00:00:00.000Z",
        ends_at: "2026-09-14T00:00:00.000Z",
        budget_limit_cents: 50_025,
        recipient_limit: 123,
        audience_rule: {
          customer_age: { kind: "within_days", days: 90 },
          order_activity: { kind: "none" },
          membership: {
            kind: "tiers",
            tier_ids: ["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
          },
        },
      }}
    />,
  );
  for (const expected of [
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "3 → 4",
    "summer_26",
    "夏季回访",
    "scheduled",
    "2026-08-14T00:00:00.000Z",
    "2026-09-14T00:00:00.000Z",
    "500.25",
    "123",
    "注册 90 天内",
    "从未下单",
    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  ]) {
    assert.equal(html.includes(expected), true, expected);
  }
});

test("audience confirmation renders full campaign and digest authority without recipients", () => {
  const html = renderToStaticMarkup(
    <MarketingAudienceFreezeConfirmationDetails
      summary={{
        kind: "marketing_audience_freeze",
        campaign_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        campaign_code: "summer_26",
        campaign_name: "夏季回访",
        campaign_version: 2,
        audience_rule_sha256: "a".repeat(64),
        audience_digest: "b".repeat(64),
        recipient_count: 12,
      }}
    />,
  );
  assert.match(html, /aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/u);
  assert.match(html, /a{64}/u);
  assert.match(html, /b{64}/u);
  assert.match(html, /冻结 12 人/u);
  assert.doesNotMatch(html, /customer_ids|手机号|姓名/u);
});
