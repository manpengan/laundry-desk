import assert from "node:assert/strict";
import test from "node:test";

import type {
  NotificationDeliveryBatchGetResult,
  NotificationDeliveryBatchSummary,
  PickupReminderCandidate,
} from "@laundry/contracts";
import { DEFAULT_PICKUP_REMINDER_TEMPLATE } from "@laundry/domain";

import type { ActorContext, CommandHandler } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createNotificationDeliveryHandlers } from "./delivery-handlers.js";
import {
  DISABLED_NOTIFICATION_CAPABILITY,
  SOFTWARE_ONLY_NOTIFICATION_CAPABILITY,
} from "./delivery-provider.js";
import type {
  NotificationDeliveryEnqueueRequest,
  NotificationDeliveryStore,
} from "./delivery-types.js";
import type { NotificationHandlerDeps, NotificationStore } from "./types.js";

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ORDER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CUSTOMER_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const BATCH_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const NOW = new Date("2026-08-12T01:02:03.000Z");

const TENANT: TenantContext = Object.freeze({
  orgId: ORG_ID,
  storeId: STORE_ID,
  staffId: STAFF_ID,
});
const CANDIDATE: PickupReminderCandidate = Object.freeze({
  order_id: ORDER_ID,
  ticket_no: "REM-0001",
  customer_id: CUSTOMER_ID,
  customer_name: "仅用于边界测试",
  customer_phone: "13800000000",
  garment_count: 2,
  balance_cents: 500,
  received_at: "2026-01-01T00:00:00.000Z",
  overdue_days: 223,
  garment_statuses: ["racked" as const],
  last_contact_at: null,
});

const SUMMARY: NotificationDeliveryBatchSummary = Object.freeze({
  batch_id: BATCH_ID,
  status: "queued",
  assurance: "software_only",
  provider_code: "software_only_fake",
  channel: "sms",
  template_code: "pickup_reminder_v1",
  template_version: 1,
  recipient_count: 1,
  counts: Object.freeze({
    queued: 1,
    sending: 0,
    retry_wait: 0,
    accepted: 0,
    delivered: 0,
    manual_required: 0,
    cancelled: 0,
  }),
  spent_cost_cents: 0,
  max_cost_cents: 0,
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
});

const DETAIL: NotificationDeliveryBatchGetResult = Object.freeze({
  batch: SUMMARY,
  deliveries: [
    Object.freeze({
      delivery_id: ORDER_ID,
      order_id: ORDER_ID,
      ticket_no: "REM-0001",
      status: "queued",
      attempt_count: 0,
      next_attempt_at: NOW.toISOString(),
      last_error_code: null,
      cost_cents: 0,
      updated_at: NOW.toISOString(),
    }),
  ],
});

function actor(permissions: readonly string[]): ActorContext {
  return Object.freeze({
    staffId: STAFF_ID,
    deviceId: null,
    via: "ui",
    permissions: Object.freeze([...permissions]),
  });
}

async function run(
  handler: CommandHandler,
  parsed: Readonly<Record<string, unknown>>,
  permissions: readonly string[] = ["customer_read", "notification_send"],
) {
  return handler(
    Object.freeze({
      client: new FakeSqlClient(),
      tenant: TENANT,
      actor: actor(permissions),
      parsed,
      request: Object.freeze({
        name: "notification.delivery_batch.enqueue",
        version: "0.1.0",
        input: parsed,
        dryRun: false,
      }),
    }) as unknown as Parameters<CommandHandler>[0],
  );
}

function hasCode(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof HandlerCommandError);
    assert.equal(error.commandError.code, code);
    return true;
  };
}

function deps(options: { stale?: boolean; disabled?: boolean; activeDelivery?: boolean } = {}) {
  const requests: NotificationDeliveryEnqueueRequest[] = [];
  const reminder: NotificationStore = Object.freeze({
    listPickupReminders: async () => (options.stale === true ? Object.freeze([]) : [CANDIDATE]),
    lockOrders: async (_client, _tenant, ids) => ids.length,
    appendManualList: async () => undefined,
  });
  const delivery: NotificationDeliveryStore = Object.freeze({
    getActiveTemplate: async () =>
      Object.freeze({
        id: CUSTOMER_ID,
        code: "pickup_reminder_v1" as const,
        version: 1,
        channel: "sms" as const,
        body: DEFAULT_PICKUP_REMINDER_TEMPLATE,
      }),
    assertOrdersAvailable: async () => options.activeDelivery !== true,
    enqueueBatch: async (request) => {
      requests.push(request);
      return Object.freeze({
        batch_id: request.batchId,
        status: "queued" as const,
        assurance: request.assurance,
        provider_code: request.providerCode,
        channel: "sms" as const,
        template_code: "pickup_reminder_v1" as const,
        template_version: 1,
        recipient_count: request.deliveries.length,
        order_count: request.deliveries.length,
        estimated_cost_cents: request.estimatedCostCents,
        max_cost_cents: request.input.max_cost_cents,
        created_at: request.createdAt.toISOString(),
      });
    },
    listBatches: async () => Object.freeze([SUMMARY]),
    getBatch: async (_client, _tenant, batchId) => (batchId === BATCH_ID ? DETAIL : null),
  });
  const value: NotificationHandlerDeps = Object.freeze({
    store: reminder,
    now: () => NOW,
    delivery: Object.freeze({
      store: delivery,
      capability:
        options.disabled === true
          ? DISABLED_NOTIFICATION_CAPABILITY
          : SOFTWARE_ONLY_NOTIFICATION_CAPABILITY,
    }),
  });
  return { value, requests };
}

const enqueueInput = Object.freeze({
  order_ids: Object.freeze([ORDER_ID]),
  channel: "sms",
  template_code: "pickup_reminder_v1",
  max_cost_cents: 0,
  min_age_days: 180,
  unpaid_only: true,
  garment_statuses: Object.freeze(["racked"]),
});

test("disabled capability is explicit and enqueue fails closed", async () => {
  const { value } = deps({ disabled: true });
  const handlers = createNotificationDeliveryHandlers(value);
  const capability = await run(handlers["notification.delivery.capability.get"], {}, [
    "customer_read",
  ]);
  assert.deepEqual(capability.result, DISABLED_NOTIFICATION_CAPABILITY);
  await assert.rejects(
    () => run(handlers["notification.delivery_batch.enqueue"], enqueueInput),
    hasCode("RESOURCE_UNAVAILABLE"),
  );
});

test("software-only enqueue revalidates, freezes hashes, and emits no PII evidence", async () => {
  const { value, requests } = deps();
  const handlers = createNotificationDeliveryHandlers(value);
  const outcome = await run(handlers["notification.delivery_batch.enqueue"], enqueueInput);
  const result = outcome.result as Readonly<Record<string, unknown>>;
  assert.equal(result.assurance, "software_only");
  assert.equal(result.estimated_cost_cents, 0);
  assert.equal(requests.length, 1);
  assert.match(requests[0]?.deliveries[0]?.messageSha256 ?? "", /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(JSON.stringify(outcome.audit), /13800000000|仅用于边界测试/u);
  assert.doesNotMatch(JSON.stringify(outcome.events), /13800000000|仅用于边界测试/u);
});

test("enqueue rejects a client cost ceiling above the server capability", async () => {
  const handlers = createNotificationDeliveryHandlers(deps().value);
  await assert.rejects(
    () =>
      run(
        handlers["notification.delivery_batch.enqueue"],
        Object.freeze({ ...enqueueInput, max_cost_cents: 1 }),
      ),
    hasCode("INVARIANT_FAILED"),
  );
});

test("enqueue requires both permissions and rejects stale selections atomically", async () => {
  const active = createNotificationDeliveryHandlers(deps().value);
  await assert.rejects(
    () => run(active["notification.delivery_batch.enqueue"], enqueueInput, ["customer_read"]),
    hasCode("PERMISSION_DENIED"),
  );
  const stale = createNotificationDeliveryHandlers(deps({ stale: true }).value);
  await assert.rejects(
    () => run(stale["notification.delivery_batch.enqueue"], enqueueInput),
    hasCode("INVARIANT_FAILED"),
  );
  const duplicate = createNotificationDeliveryHandlers(deps({ activeDelivery: true }).value);
  await assert.rejects(
    () => run(duplicate["notification.delivery_batch.enqueue"], enqueueInput),
    hasCode("INVARIANT_FAILED"),
  );
});

test("bounded list and get return only safe status projections", async () => {
  const handlers = createNotificationDeliveryHandlers(deps().value);
  const listed = await run(handlers["notification.delivery_batches.list"], { limit: 5 });
  const detail = await run(handlers["notification.delivery_batch.get"], {
    batch_id: BATCH_ID,
  });
  assert.deepEqual(listed.result, { batches: [SUMMARY] });
  assert.deepEqual(detail.result, DETAIL);
  assert.doesNotMatch(JSON.stringify(detail.result), /13800000000|recipient_hmac|message_sha256/u);
  await assert.rejects(
    () =>
      run(handlers["notification.delivery_batch.get"], {
        batch_id: "11111111-1111-4111-8111-111111111111",
      }),
    hasCode("RESOURCE_UNAVAILABLE"),
  );
});
