/** Server-owned payment ledger projection for the Cloud counter refund flow. */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import { executeQuery } from "../bus/execute-query.js";
import type { ActorContext } from "../bus/types.js";
import { createMemoryCatalogStore } from "../catalog/memory-catalog.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createDefaultChainHooks } from "../handlers/default-chain-hooks.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { createMemoryOrderStore } from "../order/memory-store.js";
import type { OrderStore } from "../order/types.js";
import { MemoryPendingActionStore } from "../pending-actions/store.js";

const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_STAFF_A_ID,
});

const CLERK: ActorContext = Object.freeze({
  staffId: DEMO_STAFF_A_ID,
  deviceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  via: "ui",
  permissions: Object.freeze(["order_write", "payment_refund"]),
});

const NOW = 1_721_606_400;
const BUSINESS_DATE = "2024-07-22";

function buildBus(store: OrderStore = createMemoryOrderStore()) {
  const pendingStore = new MemoryPendingActionStore();
  const bus = createRegisteredM1Bus({
    order: Object.freeze({ store, catalog: createMemoryCatalogStore(), now: () => NOW }),
  });
  return Object.freeze({
    ...bus,
    store,
    pendingStore,
    chainHooks: createDefaultChainHooks({}, pendingStore),
  });
}

async function receivePaidOrder(bus: ReturnType<typeof buildBus>) {
  const result = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.receive",
    {
      lines: [{ service_code: "wash", category_code: "shirt", qty: 1 }],
      initial_payment: { amount_cents: 1_000, method: "cash" },
    },
    {
      registry: bus.registry,
      actor: CLERK,
      chainHooks: bus.chainHooks,
      pendingStore: bus.pendingStore,
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) assert.fail("receive must succeed");
  return (result.data.result as { order_id: string }).order_id;
}

async function listLedger(
  bus: ReturnType<typeof buildBus>,
  orderId: string,
  onUnexpectedError?: (error: unknown) => void,
) {
  return executeQuery(
    new FakeSqlClient(),
    TENANT,
    "payment.ledger.list",
    { order_id: orderId },
    {
      registry: bus.queryRegistry,
      actor: CLERK,
      ...(onUnexpectedError === undefined ? {} : { onUnexpectedError }),
    },
  );
}

test("payment ledger query is registered with the bounded contract", () => {
  const { queryRegistry } = buildBus();
  const entry = queryRegistry.get("payment.ledger.list");
  assert.ok(entry?.handler);
  assert.equal(entry.definition.max_result_rows, 200);
  assert.equal(entry.definition.risk, "R2");
});

test("payment ledger query derives signed rows and remaining refundable cents", async () => {
  const bus = buildBus();
  const orderId = await receivePaidOrder(bus);
  const original = (await bus.store.listPayments?.(TENANT.orgId, TENANT.storeId, orderId))?.[0];
  assert.ok(original);
  assert.equal(original.method, "cash");
  const refunded = await bus.store.appendRefund?.({
    org_id: TENANT.orgId,
    store_id: TENANT.storeId,
    order_id: orderId,
    amount_cents: 200,
    expected_method: "cash",
    ref_payment_id: original.payment_id,
    reason: "customer changed service",
    staff_id: CLERK.staffId,
    at: NOW + 1,
    business_date: BUSINESS_DATE,
  });
  assert.ok(refunded);

  const listed = await listLedger(bus, orderId);
  assert.equal(listed.ok, true, JSON.stringify(listed));
  if (!listed.ok) return;
  assert.deepEqual(listed.data.result, {
    order_id: orderId,
    order_status: "open",
    payable_cents: 1_500,
    paid_cents: 800,
    balance_cents: 700,
    payments: [
      {
        payment_id: original.payment_id,
        kind: "pay",
        method: "cash",
        amount_cents: 1_000,
        signed_cents: 1_000,
        ref_payment_id: null,
        at: NOW,
        note: null,
        active: true,
        refundable_cents: 800,
      },
      {
        payment_id: refunded.payment.payment_id,
        kind: "refund",
        method: "cash",
        amount_cents: 200,
        signed_cents: -200,
        ref_payment_id: original.payment_id,
        at: NOW + 1,
        note: "customer changed service",
        active: true,
        refundable_cents: 0,
      },
    ],
  });
});

test("payment ledger query hides missing or cross-store orders", async () => {
  const result = await listLedger(buildBus(), randomUUID());
  assert.equal(result.ok, false, JSON.stringify(result));
  if (!result.ok) assert.equal(result.error.code, "RESOURCE_UNAVAILABLE");
});

test("payment ledger query preserves cancellation reversals with zeroed order totals", async () => {
  const bus = buildBus();
  const orderId = await receivePaidOrder(bus);
  const cancelled = await bus.store.cancelOpenOrder?.(
    TENANT.orgId,
    TENANT.storeId,
    orderId,
    "operator cancellation",
    CLERK.staffId,
    NOW + 1,
    BUSINESS_DATE,
  );
  assert.equal(cancelled?.status, "cancelled");

  const listed = await listLedger(bus, orderId);
  assert.equal(listed.ok, true, JSON.stringify(listed));
  if (!listed.ok) return;
  const result = listed.data.result as {
    order_status: string;
    paid_cents: number;
    balance_cents: number;
    payments: readonly { kind: string; signed_cents: number }[];
  };
  assert.equal(result.order_status, "cancelled");
  assert.equal(result.paid_cents, 0);
  assert.equal(result.balance_cents, 0);
  assert.deepEqual(
    result.payments.map((payment) => payment.kind),
    ["pay", "reversal"],
  );
  assert.equal(
    result.payments.reduce((sum, payment) => sum + payment.signed_cents, 0),
    0,
  );
});

test("payment ledger query fails closed when stored order totals diverge", async () => {
  const backing = createMemoryOrderStore();
  const bus = buildBus(backing);
  const orderId = await receivePaidOrder(bus);
  const corruptStore: OrderStore = Object.freeze({
    insertOrder: backing.insertOrder.bind(backing),
    getOrder: backing.getOrder.bind(backing),
    listGarments: backing.listGarments.bind(backing),
    applyPickup: backing.applyPickup.bind(backing),
    nextTicketSeq: backing.nextTicketSeq.bind(backing),
    listPayments: async () => Object.freeze([]),
  });
  const corruptBus = buildBus(corruptStore);
  let captured: unknown;
  const result = await listLedger(corruptBus, orderId, (error) => {
    captured = error;
  });
  assert.equal(result.ok, false, JSON.stringify(result));
  if (!result.ok) assert.equal(result.error.code, "TRANSACTION_FAILED");
  assert.match(String(captured), /does not match the order projection/u);
});
