import assert from "node:assert/strict";
import test from "node:test";

import { notificationDeliveryBatchEnqueueCommand } from "@laundry/contracts";

import { executeCommand } from "../bus/executor.js";
import { createM1CommandRegistry } from "../bus/registry.js";
import type { ActorContext } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createDefaultChainHooks } from "../handlers/default-chain-hooks.js";
import type {
  PendingActionPreparer,
  PendingRiskPreparer,
} from "../handlers/default-chain-hooks.js";
import { MemoryPendingActionStore } from "../pending-actions/store.js";
import {
  NOTIFICATION_ACTIVE_PENDING_LIMIT,
  NOTIFICATION_ROLLING_PENDING_LIMIT,
} from "../pending-actions/types.js";
import { createStepUpProof } from "../policy/step-up.js";
import { MemoryStepUpProofStore } from "../policy/step-up-proof-store.js";

const CREATOR_ID = "11111111-1111-4111-8111-111111111111";
const APPROVER_ID = "22222222-2222-4222-8222-222222222222";
const TENANT: TenantContext = Object.freeze({
  orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  storeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  staffId: CREATOR_ID,
});
const ACTOR: ActorContext = Object.freeze({
  staffId: CREATOR_ID,
  deviceId: null,
  via: "ui",
  permissions: Object.freeze(["customer_read", "notification_send"]),
});
const SESSION = Object.freeze({ sessionId: "notification-policy-session", sessionVersion: 1 });

function orderIds(count: number): readonly string[] {
  return Object.freeze(
    Array.from(
      { length: count },
      (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    ),
  );
}

function input(count: number) {
  return Object.freeze({
    order_ids: orderIds(count),
    channel: "sms" as const,
    template_code: "pickup_reminder_v1" as const,
    max_cost_cents: 0,
    min_age_days: 180 as const,
    unpaid_only: true,
    garment_statuses: Object.freeze(["racked" as const]),
  });
}

function registry() {
  const result = createM1CommandRegistry([notificationDeliveryBatchEnqueueCommand]);
  result.registerHandler(notificationDeliveryBatchEnqueueCommand.name, async () =>
    Object.freeze({ result: Object.freeze({ queued: true }) }),
  );
  return result;
}

async function gate(count: number, pendingStore: MemoryPendingActionStore) {
  return executeCommand(
    new FakeSqlClient(),
    TENANT,
    notificationDeliveryBatchEnqueueCommand.name,
    input(count),
    {
      actor: ACTOR,
      registry: registry(),
      chainHooks: createDefaultChainHooks({}, pendingStore),
      pendingStore,
    },
  );
}

function rollingRiskRequest(nowEpochSeconds: number, parsed: unknown) {
  const orders = (parsed as Readonly<{ order_ids: readonly string[] }>).order_ids;
  return Object.freeze({
    kind: "notification_delivery_rolling_24h" as const,
    command: "notification.delivery_batch.enqueue" as const,
    commandVersion: "0.1.0" as const,
    units: orders.length,
    threshold: 10 as const,
    windowSeconds: 86_400 as const,
    activePendingLimit: NOTIFICATION_ACTIVE_PENDING_LIMIT,
    rollingPendingLimit: NOTIFICATION_ROLLING_PENDING_LIMIT,
    nowEpochSeconds,
  });
}

function rollingRiskPreparer(
  nowEpochSeconds: number,
  onPrepare: () => void = () => undefined,
): PendingActionPreparer {
  return async (parsed) => {
    onPrepare();
    const orders = (parsed as Readonly<{ order_ids: readonly string[] }>).order_ids;
    return Object.freeze({
      authority: Object.freeze({ kind: "notification_delivery_test" }),
      summary: Object.freeze({
        kind: "notification_delivery_batch" as const,
        order_count: orders.length,
        risk_window_order_count: orders.length,
        ticket_nos: Object.freeze(orders.map((_, index) => `T-${index + 1}`)),
        channel: "sms" as const,
        assurance: "software_only" as const,
        provider_code: "software_test",
        template_code: "pickup_reminder_v1" as const,
        template_version: 1,
        estimated_cost_cents: 0,
        max_cost_cents: 0,
        min_age_days: 180 as const,
        unpaid_only: true,
        garment_statuses: Object.freeze(["racked" as const]),
      }),
      riskReservation: rollingRiskRequest(nowEpochSeconds, parsed),
    });
  };
}

function rollingRiskPrecheck(nowEpochSeconds: number): PendingRiskPreparer {
  return (parsed) => rollingRiskRequest(nowEpochSeconds, parsed);
}

async function rollingGate(
  count: number,
  pendingStore: MemoryPendingActionStore,
  nowEpochSeconds: number,
  idempotencyKey?: string,
  onPrepare?: () => void,
) {
  return executeCommand(
    new FakeSqlClient(),
    TENANT,
    notificationDeliveryBatchEnqueueCommand.name,
    input(count),
    {
      actor: ACTOR,
      registry: registry(),
      chainHooks: createDefaultChainHooks(
        {},
        pendingStore,
        rollingRiskPreparer(nowEpochSeconds, onPrepare),
        rollingRiskPrecheck(nowEpochSeconds),
      ),
      pendingStore,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    },
  );
}

function confirmationRef(result: Awaited<ReturnType<typeof gate>>): string {
  if (result.ok) assert.fail("expected confirmation failure");
  const detail = "detail" in result.error ? result.error.detail : undefined;
  if (detail?.kind !== "confirmation") {
    assert.fail("expected confirmation detail");
  }
  return detail.confirm_ref;
}

test("notification batch risk stays R3 at 10 and escalates to R4 at 11 and 50", async () => {
  for (const [count, code, effectiveRisk, requiresOther] of [
    [10, "POLICY_CONFIRMATION_REQUIRED", "R3", false],
    [11, "POLICY_STEP_UP_REQUIRED", "R4", true],
    [50, "POLICY_STEP_UP_REQUIRED", "R4", true],
  ] as const) {
    const pendingStore = new MemoryPendingActionStore();
    const result = await gate(count, pendingStore);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, code);
    const pending = await pendingStore.get(confirmationRef(result));
    assert.equal(pending?.effectiveRisk, effectiveRisk);
    assert.equal(pending?.requiresOtherApprover, requiresOther);
  }
});

test("notification batch rejects 51 orders before creating a pending card", async () => {
  const pendingStore = new MemoryPendingActionStore();
  const result = await gate(51, pendingStore);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "VALIDATION_FAILED");
  assert.equal(pendingStore.size(), 0);
});

test("rolling store risk prevents 10+1 and repeated ten-order split batches", async () => {
  const pendingStore = new MemoryPendingActionStore();
  const first = await rollingGate(10, pendingStore, 1_000);
  assert.equal(first.ok, false);
  if (!first.ok) assert.equal(first.error.code, "POLICY_CONFIRMATION_REQUIRED");

  const second = await rollingGate(1, pendingStore, 1_001);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.error.code, "POLICY_STEP_UP_REQUIRED");
  const secondCard = await pendingStore.get(confirmationRef(second));
  assert.equal(secondCard?.effectiveRisk, "R4");
  assert.equal(secondCard?.requiresOtherApprover, true);
  assert.equal(
    (
      secondCard?.authority as
        Readonly<{ risk_reservation?: { aggregate_units: number } }> | undefined
    )?.risk_reservation?.aggregate_units,
    11,
  );

  for (let index = 0; index < 4; index += 1) {
    const split = await rollingGate(10, pendingStore, 1_002 + index);
    assert.equal(split.ok, false);
    if (!split.ok) assert.equal(split.error.code, "POLICY_STEP_UP_REQUIRED");
  }
});

test("expired unconsumed notification cards release rolling risk capacity", async () => {
  const pendingStore = new MemoryPendingActionStore();
  const first = await rollingGate(10, pendingStore, 1_000);
  assert.equal(first.ok, false);
  const afterExpiry = await rollingGate(1, pendingStore, 1_301);
  assert.equal(afterExpiry.ok, false);
  if (!afterExpiry.ok) assert.equal(afterExpiry.error.code, "POLICY_CONFIRMATION_REQUIRED");
});

test("a lost first-hop response reuses one card and one rolling-risk reservation", async () => {
  const pendingStore = new MemoryPendingActionStore();
  const idempotencyKey = "99999999-9999-4999-8999-999999999999";
  let preparationCount = 0;
  const first = await rollingGate(10, pendingStore, 1_000, idempotencyKey, () => {
    preparationCount += 1;
  });
  const replay = await rollingGate(10, pendingStore, 1_001, idempotencyKey, () => {
    preparationCount += 1;
  });
  assert.equal(first.ok, false);
  assert.equal(replay.ok, false);
  if (!first.ok) assert.equal(first.error.code, "POLICY_CONFIRMATION_REQUIRED");
  if (!replay.ok) assert.equal(replay.error.code, "POLICY_CONFIRMATION_REQUIRED");
  assert.equal(confirmationRef(replay), confirmationRef(first));
  assert.equal(pendingStore.size(), 1);
  assert.equal(preparationCount, 1);
  if (!first.ok && !replay.ok) {
    const firstDetail = "detail" in first.error ? first.error.detail : undefined;
    const replayDetail = "detail" in replay.error ? replay.error.detail : undefined;
    assert.deepEqual(firstDetail, replayDetail);
  }

  const conflicting = await rollingGate(1, pendingStore, 1_002, idempotencyKey);
  assert.equal(conflicting.ok, false);
  if (!conflicting.ok) assert.equal(conflicting.error.code, "POLICY_DENIED");
  assert.equal(pendingStore.size(), 1);
});

test("active notification pending cards are bounded per store across idempotency keys", async () => {
  const pendingStore = new MemoryPendingActionStore();
  for (let index = 0; index < NOTIFICATION_ACTIVE_PENDING_LIMIT; index += 1) {
    const result = await rollingGate(
      1,
      pendingStore,
      1_000,
      `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(
        result.error.code,
        index < 10 ? "POLICY_CONFIRMATION_REQUIRED" : "POLICY_STEP_UP_REQUIRED",
      );
    }
  }
  const denied = await rollingGate(1, pendingStore, 1_000, "20000000-0000-4000-8000-000000000001");
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, "POLICY_DENIED");
  assert.equal(pendingStore.size(), NOTIFICATION_ACTIVE_PENDING_LIMIT);

  let expensivePreparationCount = 0;
  const deniedBeforePreparing = await rollingGate(
    1,
    pendingStore,
    1_000,
    "20000000-0000-4000-8000-000000000003",
    () => {
      expensivePreparationCount += 1;
    },
  );
  assert.equal(deniedBeforePreparing.ok, false);
  assert.equal(expensivePreparationCount, 0);

  const afterActiveExpiry = await rollingGate(
    1,
    pendingStore,
    1_301,
    "20000000-0000-4000-8000-000000000002",
  );
  assert.equal(afterActiveExpiry.ok, false);
  if (!afterActiveExpiry.ok) assert.equal(afterActiveExpiry.error.code, "POLICY_DENIED");
  assert.equal(pendingStore.size(), NOTIFICATION_ROLLING_PENDING_LIMIT);
});

test("an escalated notification batch rejects self approval and resumes with another approver proof", async () => {
  const pendingStore = new MemoryPendingActionStore();
  const commandRegistry = registry();
  const chainHooks = createDefaultChainHooks({}, pendingStore);
  const first = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    notificationDeliveryBatchEnqueueCommand.name,
    input(11),
    { actor: ACTOR, registry: commandRegistry, chainHooks, pendingStore },
  );
  const confirmRef = confirmationRef(first);
  const self = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    notificationDeliveryBatchEnqueueCommand.name,
    {},
    { actor: ACTOR, registry: commandRegistry, chainHooks, pendingStore, confirmRef },
  );
  assert.equal(self.ok, false);
  if (!self.ok) assert.equal(self.error.code, "POLICY_DENIED");

  const pending = await pendingStore.get(confirmRef);
  assert.ok(pending);
  const proofStore = new MemoryStepUpProofStore();
  proofStore.insert(
    createStepUpProof({
      proofId: "33333333-3333-4333-8333-333333333333",
      pending,
      approverStaffId: APPROVER_ID,
      issuedAt: Math.floor(Date.now() / 1_000),
      sessionBinding: SESSION,
    }),
  );
  const resumed = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    notificationDeliveryBatchEnqueueCommand.name,
    {},
    {
      actor: ACTOR,
      registry: commandRegistry,
      chainHooks,
      pendingStore,
      stepUpProofStore: proofStore,
      stepUpApproverAuthority: async () => true,
      confirmRef,
      sessionBinding: SESSION,
    },
  );
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
});
