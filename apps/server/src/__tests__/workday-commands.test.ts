/** Money Integrity + Workday Commands: server price, ledger, draft, cancel, close gate. */

import assert from "node:assert/strict";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import type { ActorContext } from "../bus/types.js";
import { createMemoryCatalogStore } from "../catalog/memory-catalog.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createDefaultChainHooks } from "../handlers/default-chain-hooks.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import type { OrderHandlerDeps } from "../order/deps.js";
import { createMemoryOrderStore } from "../order/memory-store.js";
import type { OrderStore } from "../order/types.js";
import {
  createMemoryAuditQueryStore,
  createMemoryFeaturesStore,
  createMemorySettingsStore,
} from "../platform/index.js";
import { MemoryPendingActionStore } from "../pending-actions/store.js";

const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_STAFF_A_ID,
});

const CLERK: ActorContext = Object.freeze({
  staffId: DEMO_STAFF_A_ID,
  deviceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  via: "ui" as const,
  permissions: Object.freeze(["order_write", "staff_read"]),
});

const NOW = 1_721_606_400;
const BUSINESS_DATE = "2024-07-22";

function buildBus(overrides: Partial<OrderHandlerDeps> = {}) {
  const store = overrides.store ?? createMemoryOrderStore();
  const order: OrderHandlerDeps = Object.freeze({
    store,
    catalog: createMemoryCatalogStore(),
    now: () => NOW,
    ...overrides,
  });
  const { registry } = createRegisteredM1Bus({
    platform: Object.freeze({
      settings: createMemorySettingsStore(),
      features: createMemoryFeaturesStore(),
      audit: createMemoryAuditQueryStore(),
    }),
    order,
  });
  const pendingStore = new MemoryPendingActionStore();
  return Object.freeze({
    registry,
    store,
    pendingStore,
    chainHooks: createDefaultChainHooks({}, pendingStore),
  });
}

async function command(
  bus: ReturnType<typeof buildBus>,
  name: string,
  input: Readonly<Record<string, unknown>>,
) {
  return executeCommand(new FakeSqlClient(), TENANT, name, input, {
    registry: bus.registry,
    actor: CLERK,
    chainHooks: bus.chainHooks,
    pendingStore: bus.pendingStore,
  });
}

async function confirmedCommand(
  bus: ReturnType<typeof buildBus>,
  name: string,
  input: Readonly<Record<string, unknown>>,
) {
  const first = await command(bus, name, input);
  assert.equal(first.ok, false, JSON.stringify(first));
  if (first.ok) return first;
  assert.equal(first.error.code, "POLICY_CONFIRMATION_REQUIRED", JSON.stringify(first));
  const detail = "detail" in first.error ? first.error.detail : undefined;
  assert.equal(detail?.kind, "confirmation");
  if (detail?.kind !== "confirmation") assert.fail("missing confirmation reference");
  return executeCommand(
    new FakeSqlClient(),
    TENANT,
    name,
    {},
    {
      registry: bus.registry,
      actor: CLERK,
      chainHooks: bus.chainHooks,
      pendingStore: bus.pendingStore,
      confirmRef: detail.confirm_ref,
    },
  );
}

test("receive snapshots the catalog price and appends the selected initial payment", async () => {
  const bus = buildBus();
  const received = await command(bus, "order.receive", {
    lines: [
      {
        service_code: "wash",
        category_code: "shirt",
        unit_price_cents: 1,
        qty: 1,
      },
    ],
    initial_payment: { amount_cents: 500, method: "wechat" },
  });
  assert.equal(received.ok, true, JSON.stringify(received));
  if (!received.ok) return;
  const body = received.data.result as {
    order_id: string;
    payable_cents: number;
    paid_cents: number;
    balance_cents: number;
  };
  assert.equal(body.payable_cents, 1500);
  assert.equal(body.paid_cents, 500);
  assert.equal(body.balance_cents, 1000);
  const payments = await bus.store.listPayments?.(TENANT.orgId, TENANT.storeId, body.order_id);
  assert.equal(payments?.length, 1);
  assert.equal(payments?.[0]?.method, "wechat");
  assert.equal(payments?.[0]?.business_date, BUSINESS_DATE);
});

test("collect then repay append distinct ledger rows and settle the balance", async () => {
  const bus = buildBus();
  const received = await command(bus, "order.receive", {
    lines: [{ service_code: "wash", category_code: "shirt", qty: 1 }],
  });
  assert.equal(received.ok, true, JSON.stringify(received));
  if (!received.ok) return;
  const orderId = (received.data.result as { order_id: string }).order_id;

  const collected = await command(bus, "payment.collect", {
    order_id: orderId,
    amount_cents: 500,
    method: "cash",
  });
  assert.equal(collected.ok, true, JSON.stringify(collected));
  const repaid = await command(bus, "payment.repay", {
    order_id: orderId,
    amount_cents: 1000,
    method: "alipay",
  });
  assert.equal(repaid.ok, true, JSON.stringify(repaid));
  if (!repaid.ok) return;
  assert.equal((repaid.data.result as { balance_cents: number }).balance_cents, 0);

  const payments = await bus.store.listPayments?.(TENANT.orgId, TENANT.storeId, orderId);
  assert.deepEqual(
    payments?.map((payment) => [payment.kind, payment.amount_cents, payment.method]),
    [
      ["pay", 500, "cash"],
      ["repay", 1000, "alipay"],
    ],
  );
});

test("hold creates a ticketless draft and receive atomically consumes that draft", async () => {
  const bus = buildBus();
  const held = await command(bus, "order.hold", {
    customer_phone: "13800000111",
    lines: [{ service_code: "dry", category_code: "coat", qty: 1 }],
  });
  assert.equal(held.ok, true, JSON.stringify(held));
  if (!held.ok) return;
  const draftId = (held.data.result as { draft_id: string }).draft_id;
  const draft = await bus.store.getOrder(TENANT.orgId, TENANT.storeId, draftId);
  assert.equal(draft?.status, "draft");
  assert.equal(draft?.ticket_no, null);
  assert.equal((await bus.store.listGarments(TENANT.orgId, TENANT.storeId, draftId)).length, 0);

  const received = await command(bus, "order.receive", {
    draft_id: draftId,
    customer_phone: "13800000111",
    lines: [{ service_code: "dry", category_code: "coat", qty: 1 }],
    initial_payment: { amount_cents: 1000, method: "cash" },
  });
  assert.equal(received.ok, true, JSON.stringify(received));
  const opened = await bus.store.getOrder(TENANT.orgId, TENANT.storeId, draftId);
  assert.equal(opened?.status, "open");
  assert.match(opened?.ticket_no ?? "", /^\d{8}-\d{4}$/u);
  assert.equal((await bus.store.listGarments(TENANT.orgId, TENANT.storeId, draftId)).length, 1);
});

test("cancel records append-only reversals instead of deleting the original payment", async () => {
  const bus = buildBus();
  const received = await command(bus, "order.receive", {
    lines: [{ service_code: "wash", category_code: "shirt", qty: 1 }],
    initial_payment: { amount_cents: 1500, method: "cash" },
  });
  assert.equal(received.ok, true, JSON.stringify(received));
  if (!received.ok) return;
  const orderId = (received.data.result as { order_id: string }).order_id;

  const cancelled = await confirmedCommand(bus, "order.cancel", {
    order_id: orderId,
    reason: "customer changed mind",
  });
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  const order = await bus.store.getOrder(TENANT.orgId, TENANT.storeId, orderId);
  assert.equal(order?.status, "cancelled");
  const payments = await bus.store.listPayments?.(TENANT.orgId, TENANT.storeId, orderId);
  assert.equal(payments?.length, 2);
  assert.equal(payments?.[0]?.kind, "pay");
  assert.equal(payments?.[1]?.kind, "reversal");
  assert.equal(payments?.[1]?.ref_payment_id, payments?.[0]?.payment_id);
});

test("closed business days reject new counter writes with SHIFT_CLOSED", async () => {
  const store: OrderStore = createMemoryOrderStore();
  const bus = buildBus({ store, isBusinessDayClosed: async () => true });
  const result = await command(bus, "order.receive", {
    lines: [{ service_code: "wash", category_code: "shirt", qty: 1 }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "SHIFT_CLOSED");
});
