import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { ToastProvider } from "@laundry/ui";
import type { MarketingCampaign } from "@laundry/contracts";

import { createMockAuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { createMockCommandClient } from "../commands/command-client.js";
import { createMockQueryClient } from "../commands/query-client.js";
import { OwnerMarketingCouponReversal } from "./OwnerMarketingCouponReversal.js";
import { OwnerMarketingCoupons } from "./OwnerMarketingCoupons.js";
import { OwnerMarketingGroupBuy } from "./OwnerMarketingGroupBuy.js";
import { OwnerMarketingReferral } from "./OwnerMarketingReferral.js";

const session: SessionView = Object.freeze({
  session: Object.freeze({
    session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    session_version: 1,
    org_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    store_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    staff_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    device_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    permission_version: 1,
  }),
  role: "admin",
  features: Object.freeze({
    pricing_enabled: true,
    marketing_enabled: true,
    notifications_enabled: true,
    ai_enabled: false,
    offline_enabled: false,
  }),
  display: Object.freeze({
    store_name: "主店",
    staff_name: "店主",
    org_code: "ORG",
    store_code: "S1",
  }),
});

const campaign: MarketingCampaign = Object.freeze({
  campaign_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  code: "august_return",
  name: "八月回访",
  status: "scheduled",
  starts_at: "2026-08-13T00:00:00.000Z",
  ends_at: "2026-08-14T00:00:00.000Z",
  budget_limit_cents: 10_000,
  budget_used_cents: 1_000,
  budget_remaining_cents: 9_000,
  recipient_limit: 100,
  audience_rule: Object.freeze({
    customer_age: Object.freeze({ kind: "any" }),
    order_activity: Object.freeze({ kind: "any" }),
    membership: Object.freeze({ kind: "member" }),
  }),
  audience_rule_sha256: "a".repeat(64),
  version: 1,
  updated_at: "2026-08-13T00:00:00.000Z",
});

test("Owner marketing exposes bounded issuance and audited correction without a recipient list", () => {
  const authClient = createMockAuthClient();
  const commandClient = createMockCommandClient();
  const queryClient = createMockQueryClient();
  const html = renderToStaticMarkup(
    createElement(ToastProvider, {
      children: createElement("div", {
        children: [
          createElement(OwnerMarketingCoupons, {
            key: "issue",
            campaign,
            session,
            authClient,
            commandClient,
            queryClient,
            onChanged: async () => undefined,
          }),
          createElement(OwnerMarketingCouponReversal, {
            key: "reverse",
            session,
            authClient,
            commandClient,
          }),
          createElement(OwnerMarketingReferral, {
            key: "referral",
            campaign,
            session,
            authClient,
            commandClient,
            onChanged: async () => undefined,
          }),
          createElement(OwnerMarketingGroupBuy, {
            key: "group-buy",
            session,
            authClient,
            commandClient,
          }),
        ],
      }),
    }),
  );

  assert.match(html, /批量发券/u);
  assert.match(html, /服务端资格/u);
  assert.match(html, /核销冲正/u);
  assert.match(html, /发起冲正复核/u);
  assert.match(html, /推荐奖励/u);
  assert.match(html, /发起推荐奖励复核/u);
  assert.match(html, /团购券/u);
  assert.match(html, /原始券码仅在本机/u);
  assert.match(html, /maxLength="256"/u);
  assert.doesNotMatch(html, /recipient_ids|customer_id|account_id/iu);
});
