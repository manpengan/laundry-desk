/**
 * M2 skeleton: order.receive + order.pickup over memory store + bus.
 * Receive with phone atomically upserts customer archive when store wired.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import { executeQuery } from "../bus/execute-query.js";
import type { ActorContext } from "../bus/types.js";
import { createMemoryCustomerStore } from "../customer/memory-store.js";
import type { CustomerStore } from "../customer/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createDefaultChainHooks } from "../handlers/default-chain-hooks.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
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

function buildBus(
  orderStore: OrderStore = createMemoryOrderStore(),
  customerStore?: CustomerStore,
) {
  const { registry, queryRegistry } = createRegisteredM1Bus({
    platform: Object.freeze({
      settings: createMemorySettingsStore(),
      features: createMemoryFeaturesStore(),
      audit: createMemoryAuditQueryStore(),
    }),
    order: Object.freeze({
      store: orderStore,
      ...(customerStore !== undefined ? { customer: customerStore } : {}),
    }),
    ...(customerStore !== undefined ? { customer: Object.freeze({ store: customerStore }) } : {}),
  });
  const pendingStore = new MemoryPendingActionStore();
  const chainHooks = createDefaultChainHooks({}, pendingStore);
  return { registry, queryRegistry, chainHooks, pendingStore, orderStore, customerStore };
}

test("order.receive expands qty into garments and returns ticket_no", async () => {
  const { registry, chainHooks, pendingStore, orderStore } = buildBus();
  const result = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.receive",
    {
      customer_phone: "13800000111",
      lines: [
        {
          service_code: "wash",
          category_code: "shirt",
          unit_price_cents: 1500,
          qty: 2,
        },
      ],
      paid_cents: 500,
    },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.data.execution, "executed");
  const data = result.data.result as {
    order_id: string;
    ticket_no: string;
    payable_cents: number;
    balance_cents: number;
    garment_count: number;
    garments: readonly { status: string }[];
  };
  assert.match(data.ticket_no, /^\d{8}-\d{4}$/u);
  assert.equal(data.payable_cents, 3000);
  assert.equal(data.balance_cents, 2500);
  assert.equal(data.garment_count, 2);
  assert.equal(
    data.garments.every((g) => g.status === "received"),
    true,
  );

  const stored = await orderStore.getOrder(DEMO_ORG_ID, DEMO_STORE_ID, data.order_id);
  assert.ok(stored);
  assert.equal(stored.lines[0]?.qty, 2);
});

test("order.pickup transitions received garments and settles balance", async () => {
  const { registry, chainHooks, pendingStore, orderStore } = buildBus();
  const received = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.receive",
    {
      lines: [
        {
          service_code: "wash",
          category_code: "pants",
          unit_price_cents: 2000,
          qty: 1,
        },
      ],
      paid_cents: 0,
    },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(received.ok, true);
  if (!received.ok) return;
  const orderId = (received.data.result as { order_id: string }).order_id;

  const picked = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.pickup",
    {
      order_id: orderId,
      garment_ids: [],
      collect_cents: 2000,
    },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(picked.ok, true, JSON.stringify(picked));
  if (!picked.ok) return;
  const data = picked.data.result as {
    status: string;
    balance_cents: number;
    paid_cents: number;
    picked_garment_ids: readonly string[];
  };
  assert.equal(data.balance_cents, 0);
  assert.equal(data.paid_cents, 2000);
  assert.equal(data.status, "closed");
  assert.equal(data.picked_garment_ids.length, 1);

  const payments = await orderStore.listPayments?.(DEMO_ORG_ID, DEMO_STORE_ID, orderId);
  assert.ok(payments);
  assert.equal(payments.length, 1);
  assert.equal(payments[0]?.kind, "pay");
  assert.equal(payments[0]?.method, "cash");
  assert.equal(payments[0]?.amount_cents, 2000);
  assert.equal(payments[0]?.staff_id, DEMO_STAFF_A_ID);
  assert.equal(payments[0]?.order_id, orderId);
});

test("order.pickup with collect_cents 0 does not insert a payment", async () => {
  const orderStore = createMemoryOrderStore();
  const { registry, chainHooks, pendingStore } = buildBus(orderStore);
  const received = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.receive",
    {
      lines: [
        {
          service_code: "wash",
          category_code: "shirt",
          unit_price_cents: 1000,
          qty: 1,
        },
      ],
      paid_cents: 1000,
    },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(received.ok, true);
  if (!received.ok) return;
  const orderId = (received.data.result as { order_id: string }).order_id;

  const picked = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.pickup",
    {
      order_id: orderId,
      garment_ids: [],
      collect_cents: 0,
    },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(picked.ok, true, JSON.stringify(picked));
  const payments = await orderStore.listPayments(DEMO_ORG_ID, DEMO_STORE_ID, orderId);
  assert.equal(payments.length, 0);
});

test("order.receive without order_write is PERMISSION_DENIED", async () => {
  const { registry, chainHooks, pendingStore } = buildBus();
  const result = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.receive",
    {
      lines: [
        {
          service_code: "wash",
          category_code: "shirt",
          unit_price_cents: 1000,
          qty: 1,
        },
      ],
      paid_cents: 0,
    },
    {
      registry,
      actor: Object.freeze({
        ...CLERK,
        permissions: Object.freeze(["staff_read"]),
      }),
      chainHooks,
      pendingStore,
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "PERMISSION_DENIED");
});

test("order.receive with phone upserts searchable customer", async () => {
  const customerStore = createMemoryCustomerStore([]);
  const { registry, queryRegistry, chainHooks, pendingStore } = buildBus(
    createMemoryOrderStore(),
    customerStore,
  );

  const result = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.receive",
    {
      customer_phone: "13800000444",
      customer_name: "赵六",
      lines: [
        {
          service_code: "wash",
          category_code: "shirt",
          unit_price_cents: 1500,
          qty: 1,
        },
      ],
      paid_cents: 1500,
    },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );

  assert.equal(result.ok, true, JSON.stringify(result));

  const byPhone = await customerStore.getByPhone("13800000444");
  assert.equal(byPhone?.name, "赵六");
  assert.equal(byPhone?.phone, "13800000444");

  const search = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "customer.search",
    { query: "138000004" },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(search.ok, true, JSON.stringify(search));
  if (!search.ok) return;
  const customers = (
    search.data.result as { customers: readonly { phone: string; name: string | null }[] }
  ).customers;
  assert.equal(customers.length, 1);
  assert.equal(customers[0]?.phone, "13800000444");
  assert.equal(customers[0]?.name, "赵六");
});

test("order.receive rolls back when its customer upsert fails", async () => {
  const brokenCustomer: CustomerStore = Object.freeze({
    search: async () => Object.freeze([]),
    getByPhone: async () => null,
    upsert: async () => {
      throw new Error("simulated customer store failure");
    },
  });
  const orderStore = createMemoryOrderStore();
  const { registry, chainHooks, pendingStore } = buildBus(orderStore, brokenCustomer);

  const result = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.receive",
    {
      customer_phone: "13800000555",
      customer_name: "钱七",
      lines: [
        {
          service_code: "wash",
          category_code: "coat",
          unit_price_cents: 2000,
          qty: 1,
        },
      ],
      paid_cents: 0,
    },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );

  assert.equal(result.ok, false, JSON.stringify(result));
  if (!result.ok) assert.equal(result.error.code, "TRANSACTION_FAILED");
  assert.deepEqual(await orderStore.listOrders?.(DEMO_ORG_ID, DEMO_STORE_ID), []);
});

test("order.receive without customer store still works with phone", async () => {
  const { registry, chainHooks, pendingStore } = buildBus();
  const result = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.receive",
    {
      customer_phone: "13800000666",
      lines: [
        {
          service_code: "wash",
          category_code: "shirt",
          unit_price_cents: 1000,
          qty: 1,
        },
      ],
      paid_cents: 1000,
    },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
});
