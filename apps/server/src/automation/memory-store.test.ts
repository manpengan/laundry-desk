import assert from "node:assert/strict";
import test from "node:test";

import type { AutomationPolicyDraft } from "@laundry/contracts";

import { FakeSqlClient } from "../db/fake-client.js";
import type { AutomationStoreContext } from "./types.js";
import { MemoryAutomationStore } from "./memory-store.js";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const STORE_ID = "22222222-2222-4222-8222-222222222222";
const ADMIN_ID = "33333333-3333-4333-8333-333333333333";
const POLICY_ID = "44444444-4444-4444-8444-444444444444";
const RUN_ID = "55555555-5555-4555-8555-555555555555";
const LEASE_ID = "66666666-6666-4666-8666-666666666666";
const HASH = "a".repeat(64);

const context: AutomationStoreContext = Object.freeze({
  client: new FakeSqlClient(),
  tenant: Object.freeze({ orgId: ORG_ID, storeId: STORE_ID, staffId: ADMIN_ID }),
});

const draft: AutomationPolicyDraft = Object.freeze({
  name: "超期取件提醒",
  tool: "notification.delivery_batch.enqueue",
  object_filter: Object.freeze({
    min_age_days: 90,
    unpaid_only: true,
    garment_statuses: Object.freeze(["ready", "racked"] as const),
    max_objects: 10,
  }),
  schedule: Object.freeze({
    cadence: "daily",
    local_time: "10:00",
    days_of_week: Object.freeze([0, 1, 2, 3, 4, 5, 6]),
    window_start_local: "09:00",
    window_end_local: "11:00",
  }),
  limits: Object.freeze({ max_runs_per_day: 1, max_amount_cents: 100 }),
  valid_from: "2026-08-13T00:00:00.000Z",
  valid_until: null,
  reason: "减少长期滞留",
});

test("memory automation requires approval, leases quota atomically and pauses fail closed", async () => {
  const store = new MemoryAutomationStore({
    timeZone: "UTC",
    isActiveAdmin: (orgId, storeId, staffId) =>
      orgId === ORG_ID && storeId === STORE_ID && staffId === ADMIN_ID,
  });
  const approvedAt = new Date("2026-08-13T09:00:00.000Z");
  assert.equal(await store.create(context, POLICY_ID, draft, approvedAt), true);
  assert.equal((await store.get(context, POLICY_ID))?.status, "pending_approval");
  assert.equal(
    await store
      .listDue(context, new Date("2026-08-13T10:00:00.000Z"), 10)
      .then((rows) => rows.length),
    0,
  );
  assert.equal(await store.transition(context, POLICY_ID, 1, "approve", approvedAt), true);

  const startedAt = new Date("2026-08-13T10:00:00.000Z");
  assert.equal((await store.listDue(context, startedAt, 10)).length, 1);
  assert.deepEqual(
    await store.beginAttempt(context, {
      policyId: POLICY_ID,
      policyVersion: 2,
      runId: RUN_ID,
      leaseToken: LEASE_ID,
      argsSha256: HASH,
      objectCount: 1,
      amountCents: 100,
      startedAt,
    }),
    { authorized: true, reason: "AUTHORIZED" },
  );

  const retryAt = new Date("2026-08-13T10:06:00.000Z");
  assert.deepEqual(
    await store.beginAttempt(context, {
      policyId: POLICY_ID,
      policyVersion: 2,
      runId: "77777777-7777-4777-8777-777777777777",
      leaseToken: "88888888-8888-4888-8888-888888888888",
      argsSha256: HASH,
      objectCount: 1,
      amountCents: 1,
      startedAt: retryAt,
    }),
    { authorized: false, reason: "QUOTA_EXCEEDED" },
  );
  const paused = await store.get(context, POLICY_ID);
  assert.equal(paused?.status, "quota_paused");
  assert.equal(paused?.next_run_at, null);
  assert.equal((await store.listRuns(context, POLICY_ID, 10))[0]?.error_code, "QUOTA_EXCEEDED");
  assert.equal(await store.transition(context, POLICY_ID, 3, "resume", retryAt), true);
  assert.equal((await store.get(context, POLICY_ID))?.status, "active");
});
