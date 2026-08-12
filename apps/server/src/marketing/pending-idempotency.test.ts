import assert from "node:assert/strict";
import test from "node:test";

import { marketingCampaignSetCommand, type MarketingCampaignSetInput } from "@laundry/contracts";

import { executeCommand } from "../bus/executor.js";
import type { ActorContext, BusContext } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { preparedPendingRetryMatches } from "../handlers/pending-policy.js";
import { MemoryPendingActionStore } from "../pending-actions/store.js";
import { createMemoryFeaturesStore } from "../platform/features.js";
import { campaignSetConfirmationSummary } from "./confirmation.js";
import { createMemoryMarketingStore } from "./memory-store.js";

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const IDEMPOTENCY_KEY = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
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
const SET_INPUT: MarketingCampaignSetInput = Object.freeze({
  expected_version: 0,
  code: "retry_campaign",
  name: "重试活动",
  status: "draft" as const,
  starts_at: "2026-08-14T00:00:00.000Z",
  ends_at: "2026-09-14T00:00:00.000Z",
  budget_limit_cents: 50_000,
  recipient_limit: 10,
  audience_rule: Object.freeze({
    customer_age: Object.freeze({ kind: "any" as const }),
    order_activity: Object.freeze({ kind: "none" as const }),
    membership: Object.freeze({ kind: "non_member" as const }),
  }),
});

function confirmationRef(result: Awaited<ReturnType<typeof executeCommand>>): string {
  assert.equal(result.ok, false);
  if (result.ok) {
    return assert.fail(`confirmation required: ${JSON.stringify(result)}`);
  }
  const detail = "detail" in result.error ? result.error.detail : undefined;
  if (detail?.kind !== "confirmation") {
    return assert.fail(`confirmation required: ${JSON.stringify(result)}`);
  }
  return detail.confirm_ref;
}

function setup(pendingStore: MemoryPendingActionStore) {
  return createRegisteredM1Bus(
    {
      marketing: Object.freeze({
        store: createMemoryMarketingStore(),
        features: createMemoryFeaturesStore({ [STORE_ID]: { marketing: true } }),
        now: () => new Date("2026-08-13T02:00:00.000Z"),
      }),
    },
    pendingStore,
  );
}

async function firstHop(
  pendingStore: MemoryPendingActionStore,
  input: typeof SET_INPUT,
  idempotencyKey = IDEMPOTENCY_KEY,
) {
  const bus = setup(pendingStore);
  return executeCommand(new FakeSqlClient(), TENANT, marketingCampaignSetCommand.name, input, {
    registry: bus.registry,
    actor: ACTOR,
    chainHooks: bus.chainHooks,
    pendingStore,
    idempotencyKey,
  });
}

test("exact marketing first-hop retries reuse one pending confirmation", async () => {
  const pendingStore = new MemoryPendingActionStore();
  const first = confirmationRef(await firstHop(pendingStore, SET_INPUT));
  const retry = confirmationRef(await firstHop(pendingStore, SET_INPUT));
  assert.equal(retry, first);
  assert.equal(pendingStore.size(), 1);
});

test("a stable marketing idempotency key fails closed when args drift", async () => {
  const pendingStore = new MemoryPendingActionStore();
  confirmationRef(await firstHop(pendingStore, SET_INPUT));
  const drifted = await firstHop(
    pendingStore,
    Object.freeze({ ...SET_INPUT, budget_limit_cents: SET_INPUT.budget_limit_cents + 1 }),
  );
  assert.equal(drifted.ok, false);
  if (!drifted.ok) assert.equal(drifted.error.code, "POLICY_DENIED");
  assert.equal(pendingStore.size(), 1);
});

test("a prepared marketing retry rejects server authority drift", async () => {
  const pendingStore = new MemoryPendingActionStore();
  const ref = confirmationRef(await firstHop(pendingStore, SET_INPUT));
  const existing = pendingStore.get(ref);
  assert.notEqual(existing, null);
  if (existing === null) return;
  const context: BusContext = Object.freeze({
    tenant: TENANT,
    actor: ACTOR,
    definition: marketingCampaignSetCommand,
    request: Object.freeze({
      name: marketingCampaignSetCommand.name,
      version: marketingCampaignSetCommand.version,
      input: SET_INPUT,
      dryRun: false,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
  });
  const driftedAuthority = Object.freeze({
    ...campaignSetConfirmationSummary(SET_INPUT),
    name: "服务端已变化",
  });
  assert.equal(
    preparedPendingRetryMatches(
      existing,
      SET_INPUT,
      context,
      Object.freeze({ authority: driftedAuthority }),
      Object.freeze({
        outcome: "confirm" as const,
        effectiveRisk: "R3" as const,
        escalated: false,
        requiresOtherApprover: false,
      }),
    ),
    false,
  );
});
