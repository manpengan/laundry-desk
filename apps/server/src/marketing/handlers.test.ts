import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  MarketingCampaignAudienceFreezeResultSchema,
  MarketingCampaignAudiencePreviewResultSchema,
  MarketingCampaignSetResultSchema,
} from "@laundry/contracts";

import type { ActorContext, CommandHandler } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createMemoryFeaturesStore } from "../platform/features.js";
import { createMarketingHandlers } from "./handlers.js";
import { createMemoryMarketingStore } from "./memory-store.js";

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CUSTOMER_A = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CUSTOMER_B = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const CAMPAIGN_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const SNAPSHOT_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-08-13T02:00:00.000Z");

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
  code: "new_customer",
  name: "新客回访",
  status: "draft",
  starts_at: "2026-08-14T00:00:00.000Z",
  ends_at: "2026-09-14T00:00:00.000Z",
  budget_limit_cents: 50_000,
  recipient_limit: 1,
  audience_rule: Object.freeze({
    customer_age: Object.freeze({ kind: "any" }),
    order_activity: Object.freeze({ kind: "any" }),
    membership: Object.freeze({ kind: "non_member" }),
  }),
});

function context(parsed: unknown, actor: ActorContext = ACTOR) {
  return Object.freeze({
    client: new FakeSqlClient(),
    tenant: TENANT,
    actor,
    parsed,
    request: Object.freeze({
      name: "marketing.campaign.set",
      version: "0.1.0",
      input: parsed,
      dryRun: false,
    }),
  }) as Parameters<CommandHandler>[0];
}

function handlers(marketing: boolean) {
  const ids = [CAMPAIGN_ID, SNAPSHOT_ID];
  return createMarketingHandlers({
    store: createMemoryMarketingStore({
      newId: () => ids.shift() ?? randomUUID(),
      customers: Object.freeze([
        Object.freeze({
          customerId: CUSTOMER_B,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          lastOrderAt: null,
          activeMember: false,
          tierId: null,
          tierValidUntil: null,
        }),
        Object.freeze({
          customerId: CUSTOMER_A,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          lastOrderAt: null,
          activeMember: false,
          tierId: null,
          tierValidUntil: null,
        }),
      ]),
    }),
    features: createMemoryFeaturesStore({ [STORE_ID]: { marketing } }),
    now: () => NOW,
  });
}

test("marketing is fail-closed unless both feature and admin permission are present", async () => {
  const disabled = handlers(false)["marketing.campaign.set"];
  await assert.rejects(
    () => disabled(context(SET_INPUT)),
    (error: unknown) => {
      assert.ok(error instanceof HandlerCommandError);
      assert.equal(error.commandError.code, "RESOURCE_UNAVAILABLE");
      return true;
    },
  );

  const enabled = handlers(true)["marketing.campaign.set"];
  await assert.rejects(
    () =>
      enabled(
        context(SET_INPUT, Object.freeze({ ...ACTOR, permissions: Object.freeze([] as string[]) })),
      ),
    (error: unknown) => {
      assert.ok(error instanceof HandlerCommandError);
      assert.equal(error.commandError.code, "PERMISSION_DENIED");
      return true;
    },
  );
});

test("marketing extensions keep the same feature-off and permission boundary", async () => {
  const input = Object.freeze({
    campaign_id: CAMPAIGN_ID,
    expected_version: 1,
    referrer_customer_id: CUSTOMER_A,
    referred_customer_id: CUSTOMER_B,
    qualifying_order_id: SNAPSHOT_ID,
    coupon_definition_id: STORE_ID,
    reason: "boundary check",
  });
  await assert.rejects(
    () => handlers(false)["marketing.referral.reward.issue"](context(input)),
    (error: unknown) =>
      error instanceof HandlerCommandError && error.commandError.code === "RESOURCE_UNAVAILABLE",
  );
  await assert.rejects(
    () =>
      handlers(true)["marketing.referral.reward.issue"](
        context(input, Object.freeze({ ...ACTOR, permissions: Object.freeze([] as string[]) })),
      ),
    (error: unknown) =>
      error instanceof HandlerCommandError && error.commandError.code === "PERMISSION_DENIED",
  );
});

test("campaign set, aggregate preview and digest-only freeze form one audited slice", async () => {
  const api = handlers(true);
  const created = await api["marketing.campaign.set"](context(SET_INPUT));
  const campaign = MarketingCampaignSetResultSchema.parse(created.result).campaign;
  assert.equal(campaign.campaign_id, CAMPAIGN_ID);
  assert.equal(campaign.budget_limit_cents, 50_000);
  assert.equal(campaign.budget_used_cents, 0);
  assert.equal(created.audit?.entity, "marketing_campaign");

  const previewed = await api["marketing.campaign.audience.preview"](
    context({ campaign_id: CAMPAIGN_ID, expected_version: 1 }),
  );
  const preview = MarketingCampaignAudiencePreviewResultSchema.parse(previewed.result);
  assert.equal(preview.matched_count, 2);
  assert.equal(preview.recipient_count, 1);
  assert.equal(preview.truncated, true);
  assert.equal(JSON.stringify(preview).includes(CUSTOMER_A), false);
  assert.equal(JSON.stringify(preview).includes(CUSTOMER_B), false);

  const frozen = await api["marketing.campaign.audience.freeze"](
    context({
      campaign_id: CAMPAIGN_ID,
      expected_version: 1,
      preview_digest: preview.audience_digest,
      expected_recipient_count: preview.recipient_count,
    }),
  );
  const snapshot = MarketingCampaignAudienceFreezeResultSchema.parse(frozen.result).snapshot;
  assert.equal(snapshot.snapshot_id, SNAPSHOT_ID);
  assert.equal(snapshot.recipient_count, 1);
  assert.equal(frozen.audit?.afterJson?.includes(CUSTOMER_A), false);
  assert.equal(frozen.audit?.afterJson?.includes(CUSTOMER_B), false);

  const replayed = await api["marketing.campaign.audience.freeze"](
    context({
      campaign_id: CAMPAIGN_ID,
      expected_version: 1,
      preview_digest: preview.audience_digest,
      expected_recipient_count: preview.recipient_count,
    }),
  );
  assert.equal(
    MarketingCampaignAudienceFreezeResultSchema.parse(replayed.result).snapshot.snapshot_id,
    SNAPSHOT_ID,
  );
});

test("campaign code and version are immutable update authorities", async () => {
  const api = handlers(true);
  await api["marketing.campaign.set"](context(SET_INPUT));
  await assert.rejects(
    () =>
      api["marketing.campaign.set"](
        context({
          ...SET_INPUT,
          campaign_id: CAMPAIGN_ID,
          expected_version: 1,
          code: "changed_code",
        }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof HandlerCommandError);
      assert.equal(error.commandError.code, "IDEMPOTENCY_CONFLICT");
      return true;
    },
  );
});

test("freeze re-evaluates and fails closed when the preview digest drifts", async () => {
  const api = handlers(true);
  await api["marketing.campaign.set"](context(SET_INPUT));
  await assert.rejects(
    () =>
      api["marketing.campaign.audience.freeze"](
        context({
          campaign_id: CAMPAIGN_ID,
          expected_version: 1,
          preview_digest: "0".repeat(64),
          expected_recipient_count: 1,
        }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof HandlerCommandError);
      assert.equal(error.commandError.code, "INVARIANT_FAILED");
      return true;
    },
  );
});
