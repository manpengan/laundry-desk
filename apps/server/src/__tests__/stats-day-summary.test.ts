/**
 * M2 skeleton: stats.day.summary over order-backed memory source + bus.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import { executeQuery } from "../bus/execute-query.js";
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
import { createMemoryStatsSource, createOrderBackedStatsQuery } from "../stats/memory-source.js";

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

/** Fixed: 2024-07-22T00:00:00.000Z */
const DAY_EPOCH = 1_721_606_400;
const BUSINESS_DATE = "2024-07-22";

function buildBus(orderStore = createMemoryOrderStore(), fixedNow = () => DAY_EPOCH) {
  const paymentStore = createMemoryPaymentStore();
  const statsSource = createOrderBackedStatsQuery(orderStore, paymentStore);
  const { registry, queryRegistry } = createRegisteredM1Bus({
    platform: Object.freeze({
      settings: createMemorySettingsStore(),
      features: createMemoryFeaturesStore(),
      audit: createMemoryAuditQueryStore(),
    }),
    order: Object.freeze({ store: orderStore, payments: paymentStore, now: fixedNow }),
    stats: Object.freeze({ source: statsSource }),
  });
  const pendingStore = new MemoryPendingActionStore();
  const chainHooks = createDefaultChainHooks({}, pendingStore);
  return { registry, queryRegistry, chainHooks, pendingStore, orderStore, paymentStore };
}

test("query registry includes stats.day.summary when stats deps present", () => {
  const { queryRegistry } = buildBus();
  assert.ok(queryRegistry.names().includes("stats.day.summary"));
  const entry = queryRegistry.get("stats.day.summary");
  assert.ok(entry?.handler);
  assert.equal(entry?.definition.name, "stats.day.summary");
  assert.equal(entry?.definition.max_result_rows, 1);
});

test("stats.day.summary is empty zeros when no orders", async () => {
  const { queryRegistry } = buildBus();
  const listed = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "stats.day.summary",
    { business_date: BUSINESS_DATE },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(listed.ok, true, JSON.stringify(listed));
  if (!listed.ok) return;
  const body = listed.data.result as {
    business_date: string;
    order_count: number;
    garment_count: number;
    payable_cents: number;
    paid_cents: number;
    balance_cents: number;
    payment_cents: number;
    picked_garment_count: number;
  };
  assert.deepEqual(body, {
    business_date: BUSINESS_DATE,
    order_count: 0,
    garment_count: 0,
    payable_cents: 0,
    paid_cents: 0,
    balance_cents: 0,
    payment_cents: 0,
    picked_garment_count: 0,
  });
});

test("stats.day.summary aggregates receive orders for the UTC day", async () => {
  const { registry, queryRegistry, chainHooks, pendingStore } = buildBus();

  const first = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.receive",
    {
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
  assert.equal(first.ok, true, JSON.stringify(first));

  const second = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.receive",
    {
      lines: [
        {
          service_code: "dry",
          category_code: "coat",
          unit_price_cents: 4500,
          qty: 1,
        },
      ],
      paid_cents: 0,
    },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(second.ok, true, JSON.stringify(second));

  const listed = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "stats.day.summary",
    { business_date: BUSINESS_DATE },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(listed.ok, true, JSON.stringify(listed));
  if (!listed.ok) return;
  const body = listed.data.result as {
    order_count: number;
    garment_count: number;
    payable_cents: number;
    paid_cents: number;
    balance_cents: number;
    payment_cents: number;
    picked_garment_count: number;
  };
  assert.equal(body.order_count, 2);
  assert.equal(body.garment_count, 3);
  assert.equal(body.payable_cents, 7500);
  assert.equal(body.paid_cents, 500);
  assert.equal(body.balance_cents, 7000);
  assert.equal(body.payment_cents, 500);
  assert.equal(body.picked_garment_count, 0);
});

test("stats.day.summary counts picked garments and pay ledger after pickup", async () => {
  const { registry, queryRegistry, chainHooks, pendingStore } = buildBus();

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

  const listed = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "stats.day.summary",
    { business_date: BUSINESS_DATE },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(listed.ok, true, JSON.stringify(listed));
  if (!listed.ok) return;
  const body = listed.data.result as {
    order_count: number;
    garment_count: number;
    payable_cents: number;
    paid_cents: number;
    balance_cents: number;
    payment_cents: number;
    picked_garment_count: number;
  };
  assert.equal(body.order_count, 1);
  assert.equal(body.garment_count, 1);
  assert.equal(body.payable_cents, 2000);
  assert.equal(body.paid_cents, 2000);
  assert.equal(body.balance_cents, 0);
  assert.equal(body.payment_cents, 2000);
  assert.equal(body.picked_garment_count, 1);
});

test("stats.day.summary ignores other UTC days", async () => {
  const otherDay = () => DAY_EPOCH + 86_400; // 2024-07-23
  const { registry, queryRegistry, chainHooks, pendingStore } = buildBus(
    createMemoryOrderStore(),
    otherDay,
  );

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
      paid_cents: 0,
    },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(received.ok, true);

  const empty = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "stats.day.summary",
    { business_date: BUSINESS_DATE },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(empty.ok, true);
  if (!empty.ok) return;
  assert.equal((empty.data.result as { order_count: number }).order_count, 0);

  const nextDay = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "stats.day.summary",
    { business_date: "2024-07-23" },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(nextDay.ok, true);
  if (!nextDay.ok) return;
  assert.equal((nextDay.data.result as { order_count: number }).order_count, 1);
});

test("memory seed overrides order-backed empty summary", async () => {
  const orderStore = createMemoryOrderStore();
  const source = createMemoryStatsSource(orderStore);
  source.seed(DEMO_ORG_ID, DEMO_STORE_ID, {
    business_date: BUSINESS_DATE,
    order_count: 9,
    garment_count: 12,
    payable_cents: 9900,
    paid_cents: 1000,
    balance_cents: 8900,
    payment_cents: 1000,
    picked_garment_count: 3,
  });

  const { queryRegistry } = createRegisteredM1Bus({
    platform: Object.freeze({
      settings: createMemorySettingsStore(),
      features: createMemoryFeaturesStore(),
      audit: createMemoryAuditQueryStore(),
    }),
    stats: Object.freeze({ source }),
  });

  const listed = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "stats.day.summary",
    { business_date: BUSINESS_DATE },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(listed.ok, true);
  if (!listed.ok) return;
  const body = listed.data.result as { order_count: number; payable_cents: number };
  assert.equal(body.order_count, 9);
  assert.equal(body.payable_cents, 9900);
});

test("stats.day.summary rejects invalid business_date", async () => {
  const { queryRegistry } = buildBus();
  const listed = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "stats.day.summary",
    { business_date: "20240722" },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(listed.ok, false);
});
