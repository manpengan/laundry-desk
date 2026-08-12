import assert from "node:assert/strict";
import test from "node:test";

import {
  marketingCampaignAudienceFreezeCommand,
  marketingCampaignSetCommand,
} from "@laundry/contracts";

import type { ActorContext, BusContext, HandlerContext } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createMemoryFeaturesStore } from "../platform/features.js";
import {
  campaignSetConfirmationSummary,
  createMarketingCampaignConfirmationPreparer,
  requireFrozenMarketingCampaign,
} from "./confirmation.js";
import { createMemoryMarketingStore } from "./memory-store.js";
import type { MarketingHandlerDeps } from "./types.js";

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CAMPAIGN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CUSTOMER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NOW = new Date("2026-08-13T02:00:00.000Z");
const CLIENT = new FakeSqlClient();
const TENANT: TenantContext = Object.freeze({
  orgId: ORG_ID,
  storeId: STORE_ID,
  staffId: STAFF_ID,
});
const ACTOR: ActorContext = Object.freeze({
  staffId: STAFF_ID,
  deviceId: null,
  via: "ui",
  permissions: Object.freeze(["marketing_manage"]),
});
const SET_INPUT = Object.freeze({
  expected_version: 0,
  code: "summer_26",
  name: "夏季回访",
  status: "draft" as const,
  starts_at: "2026-08-14T00:00:00.000Z",
  ends_at: "2026-09-14T00:00:00.000Z",
  budget_limit_cents: 50_000,
  recipient_limit: 1,
  audience_rule: Object.freeze({
    customer_age: Object.freeze({ kind: "any" as const }),
    order_activity: Object.freeze({ kind: "none" as const }),
    membership: Object.freeze({ kind: "non_member" as const }),
  }),
});

function dependencies(): MarketingHandlerDeps {
  return Object.freeze({
    store: createMemoryMarketingStore({
      newId: () => CAMPAIGN_ID,
      customers: Object.freeze([
        Object.freeze({
          customerId: CUSTOMER_ID,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          lastOrderAt: null,
          activeMember: false,
          tierId: null,
          tierValidUntil: null,
        }),
      ]),
    }),
    features: createMemoryFeaturesStore({ [STORE_ID]: { marketing: true } }),
    now: () => NOW,
  });
}

function busContext(definition: BusContext["definition"], input: unknown): BusContext {
  return Object.freeze({
    tenant: TENANT,
    actor: ACTOR,
    request: Object.freeze({
      name: definition.name,
      version: definition.version,
      input,
      dryRun: false,
    }),
    definition,
    transactionClient: CLIENT,
  });
}

test("campaign pending authority contains the complete exact set payload", async () => {
  const prepared = await createMarketingCampaignConfirmationPreparer(dependencies())(
    SET_INPUT,
    busContext(marketingCampaignSetCommand, SET_INPUT),
  );
  assert.deepEqual(prepared?.summary, campaignSetConfirmationSummary(SET_INPUT));
  assert.notDeepEqual(
    campaignSetConfirmationSummary(SET_INPUT),
    campaignSetConfirmationSummary({ ...SET_INPUT, budget_limit_cents: 50_001 }),
  );
});

test("audience freeze authority is server-resolved, digest-only and current", async () => {
  const deps = dependencies();
  const created = await deps.store.setCampaign(CLIENT, TENANT, { ...SET_INPUT, at: NOW });
  assert.equal(created.ok, true);
  const preview = await deps.store.previewAudience(CLIENT, TENANT, CAMPAIGN_ID, 1, NOW);
  assert.notEqual(preview, null);
  const input = Object.freeze({
    campaign_id: CAMPAIGN_ID,
    expected_version: 1,
    preview_digest: preview?.audienceDigest ?? "",
    expected_recipient_count: preview?.recipientCount ?? -1,
  });
  const prepared = await createMarketingCampaignConfirmationPreparer(deps)(
    input,
    busContext(marketingCampaignAudienceFreezeCommand, input),
  );
  assert.deepEqual(prepared?.summary, {
    kind: "marketing_audience_freeze",
    campaign_id: CAMPAIGN_ID,
    campaign_code: SET_INPUT.code,
    campaign_name: SET_INPUT.name,
    campaign_version: 1,
    audience_rule_sha256: preview?.campaign.audienceRuleSha256,
    audience_digest: preview?.audienceDigest,
    recipient_count: 1,
  });
  assert.equal(JSON.stringify(prepared).includes(CUSTOMER_ID), false);
});

test("a confirmation replay fails closed when its frozen campaign payload drifts", async () => {
  const context: HandlerContext = Object.freeze({
    client: CLIENT,
    tenant: TENANT,
    actor: ACTOR,
    request: Object.freeze({
      name: marketingCampaignSetCommand.name,
      version: marketingCampaignSetCommand.version,
      input: SET_INPUT,
      dryRun: false,
      confirmRef: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    }),
    parsed: SET_INPUT,
    confirmationAuthority: Object.freeze({
      kind: "marketing_campaign_set",
      ...SET_INPUT,
      budget_limit_cents: 50_001,
    }),
  });
  await assert.rejects(
    () => requireFrozenMarketingCampaign(dependencies(), context, SET_INPUT),
    (error: unknown) => {
      assert.ok(error instanceof HandlerCommandError);
      assert.equal(error.commandError.code, "POLICY_DENIED");
      return true;
    },
  );
});
