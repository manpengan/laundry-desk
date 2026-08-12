import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { groupPickupReminders, renderPickupReminder } from "@laundry/domain";

import type { TenantContext } from "../db/types.js";
import { createSoftwareOnlyNotificationProvider } from "./delivery-provider.js";
import type {
  NotificationAttemptSettlement,
  NotificationDeliveryClaim,
  NotificationProvider,
  NotificationProviderSendResult,
  NotificationWorkerStore,
} from "./delivery-types.js";
import { createNotificationWorkerController } from "./delivery-worker-controller.js";
import { runNotificationWorkerOnce } from "./delivery-worker.js";
import { MEMORY_NOTIFICATION_TEMPLATE } from "./memory-delivery-support.js";

const TENANT: TenantContext = Object.freeze({
  orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  storeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  staffId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
});
const NOW = new Date("2026-08-12T03:00:00.000Z");
const DELIVERY_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const candidate = Object.freeze({
  order_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  ticket_no: "WORK-0001",
  customer_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  customer_name: "worker boundary",
  customer_phone: "13800000000",
  garment_count: 2,
  balance_cents: 500,
  received_at: "2026-01-01T00:00:00.000Z",
  overdue_days: 223,
  garment_statuses: ["racked" as const],
  last_contact_at: null,
});
const group = groupPickupReminders([candidate], "order")[0];
assert.ok(group);
const message = renderPickupReminder(MEMORY_NOTIFICATION_TEMPLATE.body, group);
const CLAIM: NotificationDeliveryClaim = Object.freeze({
  deliveryId: DELIVERY_ID,
  batchId: "11111111-1111-4111-8111-111111111111",
  leaseToken: "22222222-2222-4222-8222-222222222222",
  attemptNo: 1,
  providerCode: "software_only_fake",
  assurance: "software_only",
  template: MEMORY_NOTIFICATION_TEMPLATE,
  candidate,
  expectedMessageSha256: createHash("sha256").update(message, "utf8").digest("hex"),
  batchEstimatedCostCents: 0,
  batchRecipientCount: 1,
  maxCostCents: 0,
  spentCostCents: 0,
  reservedCostCents: 0,
});

function fakeStore(
  claim: NotificationDeliveryClaim | null,
  settlementResult: "accepted" | "retry_wait" | "manual_required" | "stale_lease" = "accepted",
) {
  const settlements: NotificationAttemptSettlement[] = [];
  let available = claim;
  const store: NotificationWorkerStore = Object.freeze({
    claimNext: async () => {
      const result = available;
      available = null;
      return result;
    },
    settleAttempt: async (_tenant, settlement) => {
      settlements.push(settlement);
      return settlementResult;
    },
    renewLease: async () => true,
    expireAccepted: async () => 0,
    applyReceipt: async () => "not_found" as const,
  });
  return { settlements, store };
}

test("software-only worker uses delivery id as provider key and hashes accepted reference", async () => {
  const { settlements, store } = fakeStore(CLAIM);
  const sent: string[] = [];
  const base = createSoftwareOnlyNotificationProvider();
  const provider: NotificationProvider = Object.freeze({
    ...base,
    send: async (input) => {
      sent.push(input.deliveryId);
      return base.send(input);
    },
  });
  const outcome = await runNotificationWorkerOnce({
    store,
    provider,
    tenant: TENANT,
    workerId: "worker-a",
    now: () => NOW,
  });
  assert.equal(outcome.kind, "accepted");
  assert.deepEqual(sent, [DELIVERY_ID]);
  assert.equal(settlements[0]?.outcome, "accepted");
  assert.match(settlements[0]?.providerRefSha256 ?? "", /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(JSON.stringify(settlements), /13800000000|worker boundary/u);
});

test("provider mismatch and cost cap fail before any network adapter call", async () => {
  for (const claim of [
    Object.freeze({ ...CLAIM, providerCode: "other_provider" }),
    Object.freeze({
      ...CLAIM,
      batchEstimatedCostCents: 1,
      maxCostCents: 4,
      spentCostCents: 4,
    }),
  ]) {
    const { settlements, store } = fakeStore(claim, "manual_required");
    let sends = 0;
    const provider: NotificationProvider = Object.freeze({
      code: claim.providerCode === "other_provider" ? "software_only_fake" : claim.providerCode,
      assurance: "software_only",
      supportsIdempotency: true,
      supportsCancellation: true,
      unitCostCents: claim.providerCode === "other_provider" ? 0 : 1,
      maxBatchCostCents: claim.providerCode === "other_provider" ? 0 : 4,
      send: async () => {
        sends += 1;
        throw new Error("must not send");
      },
    });
    const outcome = await runNotificationWorkerOnce({
      store,
      provider,
      tenant: TENANT,
      workerId: "worker-a",
      now: () => NOW,
    });
    assert.equal(outcome.kind, "manual_required");
    assert.equal(sends, 0);
    assert.equal(settlements[0]?.outcome, "permanent_failure");
    assert.ok(
      ["PROVIDER_CONFIGURATION_CHANGED", "COST_LIMIT_EXCEEDED"].includes(
        settlements[0]?.errorCode ?? "",
      ),
    );
  }
});

test("provider timeout remains retryable only with a proven stable idempotency key", async () => {
  const { settlements, store } = fakeStore(CLAIM, "retry_wait");
  const provider: NotificationProvider = Object.freeze({
    code: "software_only_fake",
    assurance: "software_only",
    supportsIdempotency: true,
    supportsCancellation: true,
    unitCostCents: 0,
    maxBatchCostCents: 0,
    send: ({ signal }) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
  });
  const outcome = await runNotificationWorkerOnce({
    store,
    provider,
    tenant: TENANT,
    workerId: "worker-a",
    now: () => NOW,
    providerTimeoutMs: 5,
  });
  assert.equal(outcome.kind, "retry_wait");
  assert.equal(settlements[0]?.outcome, "uncertain");
  assert.equal(settlements[0]?.errorCode, "PROVIDER_TIMEOUT");
});

test("hard timeout settles even when the adapter ignores abort and stops lease renewal", async () => {
  const base = fakeStore(CLAIM, "retry_wait");
  let renewals = 0;
  const store: NotificationWorkerStore = Object.freeze({
    ...base.store,
    renewLease: async () => {
      renewals += 1;
      return true;
    },
  });
  let rejectProvider: (error: Error) => void = () => undefined;
  const provider: NotificationProvider = Object.freeze({
    code: "software_only_fake",
    assurance: "software_only",
    supportsIdempotency: true,
    supportsCancellation: true,
    unitCostCents: 0,
    maxBatchCostCents: 0,
    send: () =>
      new Promise<NotificationProviderSendResult>((_resolve, reject) => {
        rejectProvider = reject;
      }),
  });
  const outcome = await runNotificationWorkerOnce({
    store,
    provider,
    tenant: TENANT,
    workerId: "worker-a",
    now: () => NOW,
    providerTimeoutMs: 40,
  });
  assert.equal(outcome.kind, "retry_wait");
  assert.equal(base.settlements[0]?.outcome, "uncertain");
  assert.equal(base.settlements[0]?.errorCode, "PROVIDER_TIMEOUT");
  const renewalsAtDeadline = renewals;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(renewals, renewalsAtDeadline);
  rejectProvider(new Error("late provider rejection"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(base.settlements.length, 1);
});

test("provider result validation preserves accepted overage evidence and rejects widened shapes", async () => {
  const accepted = fakeStore(CLAIM, "manual_required");
  const provider: NotificationProvider = Object.freeze({
    code: "software_only_fake",
    assurance: "software_only",
    supportsIdempotency: true,
    supportsCancellation: true,
    unitCostCents: 0,
    maxBatchCostCents: 100_000,
    send: async () =>
      Object.freeze({ outcome: "accepted", errorCode: null, providerRef: "charged", costCents: 1 }),
  });
  assert.equal(
    (
      await runNotificationWorkerOnce({
        store: accepted.store,
        provider,
        tenant: TENANT,
        workerId: "worker-a",
        now: () => NOW,
      })
    ).kind,
    "manual_required",
  );
  assert.equal(accepted.settlements[0]?.outcome, "accepted");
  assert.equal(accepted.settlements[0]?.costCents, 1);
  assert.match(accepted.settlements[0]?.providerRefSha256 ?? "", /^[0-9a-f]{64}$/u);

  const invalid = fakeStore(CLAIM, "manual_required");
  const widened: NotificationProvider = Object.freeze({
    ...provider,
    send: async () =>
      ({
        outcome: "transient_failure",
        errorCode: null,
        providerRef: "must-not-survive",
        costCents: 0,
      }) as never,
  });
  await runNotificationWorkerOnce({
    store: invalid.store,
    provider: widened,
    tenant: TENANT,
    workerId: "worker-a",
    now: () => NOW,
  });
  assert.equal(invalid.settlements[0]?.outcome, "permanent_failure");
  assert.equal(invalid.settlements[0]?.errorCode, "PROVIDER_RESULT_INVALID");
  assert.equal(invalid.settlements[0]?.providerRefSha256, null);
});

test("worker controller exposes sanitized consecutive failure reports and resets on recovery", async () => {
  const reports: unknown[] = [];
  let failing = true;
  const base = fakeStore(null).store;
  const store: NotificationWorkerStore = Object.freeze({
    ...base,
    expireAccepted: async (...args) => {
      if (failing) throw new TypeError("provider failed for 13800000000");
      return base.expireAccepted(...args);
    },
  });
  const controller = createNotificationWorkerController({
    store,
    provider: createSoftwareOnlyNotificationProvider(),
    tenant: TENANT,
    workerId: "worker-controller",
    reportFailure: (report) => reports.push(report),
  });
  await controller.runNow();
  assert.equal(controller.status().consecutive_failures, 1);
  assert.equal(controller.status().last_error_code, "NOTIFICATION_WORKER_LOOP_FAILED");
  assert.doesNotMatch(JSON.stringify(reports), /13800000000|provider failed/u);
  failing = false;
  await controller.runNow();
  assert.equal(controller.status().consecutive_failures, 0);
  assert.equal(controller.status().last_error_code, null);
});

test("unproven idempotency fails closed before the provider call", async () => {
  const { settlements, store } = fakeStore(CLAIM, "manual_required");
  let sends = 0;
  const provider: NotificationProvider = Object.freeze({
    code: "software_only_fake",
    assurance: "software_only",
    supportsIdempotency: false,
    supportsCancellation: true,
    unitCostCents: 0,
    maxBatchCostCents: 0,
    send: async () => {
      sends += 1;
      return Object.freeze({
        outcome: "uncertain",
        errorCode: "PROVIDER_TIMEOUT",
        providerRef: null,
        costCents: 0,
      });
    },
  });
  await runNotificationWorkerOnce({
    store,
    provider,
    tenant: TENANT,
    workerId: "worker-a",
    now: () => NOW,
  });
  assert.equal(sends, 0);
  assert.equal(settlements[0]?.outcome, "permanent_failure");
  assert.equal(settlements[0]?.errorCode, "PROVIDER_IDEMPOTENCY_UNPROVEN");
});
