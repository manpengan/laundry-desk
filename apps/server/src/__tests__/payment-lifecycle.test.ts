import assert from "node:assert/strict";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import type { ActorContext } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createDefaultChainHooks } from "../handlers/default-chain-hooks.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { createMemoryOrderStore } from "../order/memory-store.js";
import { createMemoryPaymentStore } from "../payment/memory-store.js";
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
  permissions: Object.freeze(["order_write", "payment_refund", "staff_read"]),
});

function buildBus() {
  const orderStore = createMemoryOrderStore();
  const paymentStore = createMemoryPaymentStore();
  const pendingStore = new MemoryPendingActionStore();
  const { registry } = createRegisteredM1Bus({
    platform: Object.freeze({
      settings: createMemorySettingsStore(),
      features: createMemoryFeaturesStore(),
      audit: createMemoryAuditQueryStore(),
    }),
    order: Object.freeze({ store: orderStore, payments: paymentStore, now: () => 1_700_000_000 }),
  });
  const chainHooks = createDefaultChainHooks(
    {
      checkPolicy: async () =>
        Object.freeze({ ok: true as const, data: Object.freeze({ allowed: true as const }) }),
    },
    pendingStore,
  );
  return { chainHooks, orderStore, paymentStore, pendingStore, registry };
}

async function receiveOpenOrder(
  registry: ReturnType<typeof buildBus>["registry"],
  chainHooks: ReturnType<typeof buildBus>["chainHooks"],
  pendingStore: ReturnType<typeof buildBus>["pendingStore"],
  paidCents = 0,
): Promise<string> {
  const result = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.receive",
    {
      lines: [
        {
          service_code: "wash",
          category_code: "shirt",
          unit_price_cents: 1_000,
          qty: 1,
        },
      ],
      paid_cents: paidCents,
    },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("receive must succeed");
  return (result.data.result as { order_id: string }).order_id;
}

test("payment commands append a reconstructable ledger and update the order summary", async () => {
  const { chainHooks, orderStore, paymentStore, pendingStore, registry } = buildBus();
  const orderId = await receiveOpenOrder(registry, chainHooks, pendingStore);

  const collect = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "payment.collect",
    { order_id: orderId, amount_cents: 400, method: "cash" },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(collect.ok, true, JSON.stringify(collect));

  const repay = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "payment.repay",
    { order_id: orderId, amount_cents: 600, method: "wechat" },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(repay.ok, true, JSON.stringify(repay));

  const rows = await paymentStore.listPayments(TENANT.orgId, TENANT.storeId, orderId);
  assert.deepEqual(
    rows.map((row) => [row.kind, row.amount_cents]),
    [
      ["pay", 400],
      ["repay", 600],
    ],
  );
  const order = await orderStore.getOrder(TENANT.orgId, TENANT.storeId, orderId);
  assert.equal(order?.paid_cents, 1_000);
  assert.equal(order?.balance_cents, 0);
  assert.equal(order?.status, "open");

  const refund = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "payment.refund",
    {
      order_id: orderId,
      amount_cents: 400,
      method: "cash",
      ref_payment_id: rows[0]?.payment_id,
      reason: " customer declined service ",
    },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(refund.ok, true, JSON.stringify(refund));
  const afterRefund = await paymentStore.listPayments(TENANT.orgId, TENANT.storeId, orderId);
  assert.deepEqual(
    afterRefund.map((row) => row.kind),
    ["pay", "repay", "refund"],
  );
  assert.equal((await orderStore.getOrder(TENANT.orgId, TENANT.storeId, orderId))?.paid_cents, 600);
  assert.equal(
    (await orderStore.getOrder(TENANT.orgId, TENANT.storeId, orderId))?.balance_cents,
    400,
  );
});

test("hold keeps the frozen open status and cancel writes reversals instead of deleting payments", async () => {
  const { chainHooks, orderStore, paymentStore, pendingStore, registry } = buildBus();
  const orderId = await receiveOpenOrder(registry, chainHooks, pendingStore, 500);

  const hold = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.hold",
    { order_id: orderId, reason: " customer will return later " },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(hold.ok, true, JSON.stringify(hold));

  const cancel = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.cancel",
    { order_id: orderId, reason: " customer cancelled " },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(cancel.ok, true, JSON.stringify(cancel));

  const rows = await paymentStore.listPayments(TENANT.orgId, TENANT.storeId, orderId);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.kind, "pay");
  assert.equal(rows[1]?.kind, "reversal");
  assert.equal(rows[1]?.ref_payment_id, rows[0]?.payment_id);
  const order = await orderStore.getOrder(TENANT.orgId, TENANT.storeId, orderId);
  assert.equal(order?.status, "cancelled");
  assert.equal(order?.paid_cents, 0);
});
