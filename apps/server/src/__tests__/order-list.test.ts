/**
 * M2 order.list over memory store + query bus (workbench history).
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

/** Fixed: 2024-07-22T00:00:00.000Z */
const DAY_EPOCH = 1_721_606_400;
const BUSINESS_DATE = "2024-07-22";

function buildBus(orderStore = createMemoryOrderStore(), fixedNow = () => DAY_EPOCH) {
  const { registry, queryRegistry } = createRegisteredM1Bus({
    platform: Object.freeze({
      settings: createMemorySettingsStore(),
      features: createMemoryFeaturesStore(),
      audit: createMemoryAuditQueryStore(),
    }),
    order: Object.freeze({ store: orderStore, now: fixedNow }),
  });
  const pendingStore = new MemoryPendingActionStore();
  const chainHooks = createDefaultChainHooks({}, pendingStore);
  return { registry, queryRegistry, chainHooks, pendingStore, orderStore };
}

type ListRow = {
  order_id: string;
  ticket_no: string;
  status: string;
  customer_phone: string | null;
  customer_name: string | null;
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
  created_at: number;
  garment_count?: number;
};

test("query registry includes order.list when order deps present", () => {
  const { queryRegistry } = buildBus();
  const names = queryRegistry.names();
  assert.ok(names.includes("order.list"));
  assert.ok(names.includes("order.get"));
  const entry = queryRegistry.get("order.list");
  assert.ok(entry);
  assert.equal(entry.definition.name, "order.list");
  assert.equal(entry.definition.max_result_rows, 50);
  assert.ok(entry.handler !== undefined);
});

test("order.list returns empty array when no orders", async () => {
  const { queryRegistry } = buildBus();
  const result = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "order.list",
    {},
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  const body = result.data.result as { orders: readonly ListRow[] };
  assert.deepEqual(body.orders, []);
});

test("receive two orders → order.list returns them newest first", async () => {
  let tick = DAY_EPOCH;
  const { registry, queryRegistry, chainHooks, pendingStore } = buildBus(
    createMemoryOrderStore(),
    () => tick,
  );

  const first = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.receive",
    {
      customer_phone: "13800000111",
      customer_name: "甲",
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
  if (!first.ok) return;
  const firstId = (first.data.result as { order_id: string }).order_id;

  tick = DAY_EPOCH + 60;
  const second = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.receive",
    {
      customer_phone: "13800000222",
      customer_name: "乙",
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
  if (!second.ok) return;
  const secondId = (second.data.result as { order_id: string }).order_id;

  const listed = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "order.list",
    {},
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(listed.ok, true, JSON.stringify(listed));
  if (!listed.ok) return;

  const body = listed.data.result as { orders: readonly ListRow[] };
  assert.equal(body.orders.length, 2);
  assert.equal(body.orders[0]?.order_id, secondId);
  assert.equal(body.orders[1]?.order_id, firstId);

  const newer = body.orders[0]!;
  assert.equal(newer.status, "open");
  assert.equal(newer.customer_phone, "13800000222");
  assert.equal(newer.customer_name, "乙");
  assert.equal(newer.payable_cents, 4500);
  assert.equal(newer.paid_cents, 0);
  assert.equal(newer.balance_cents, 4500);
  assert.equal(newer.created_at, DAY_EPOCH + 60);
  assert.equal(newer.garment_count, 1);
  assert.match(newer.ticket_no, /^\d{8}-\d{4}$/u);

  const older = body.orders[1]!;
  assert.equal(older.order_id, firstId);
  assert.equal(older.payable_cents, 3000);
  assert.equal(older.paid_cents, 500);
  assert.equal(older.balance_cents, 2500);
  assert.equal(older.garment_count, 2);
});

test("order.list filters by business_date and status", async () => {
  let tick = DAY_EPOCH;
  const { registry, queryRegistry, chainHooks, pendingStore } = buildBus(
    createMemoryOrderStore(),
    () => tick,
  );

  const openRecv = await executeCommand(
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
  assert.equal(openRecv.ok, true);
  if (!openRecv.ok) return;
  const openId = (openRecv.data.result as { order_id: string }).order_id;

  tick = DAY_EPOCH + 10;
  const toClose = await executeCommand(
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
  assert.equal(toClose.ok, true);
  if (!toClose.ok) return;
  const closeId = (toClose.data.result as { order_id: string }).order_id;

  const picked = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.pickup",
    {
      order_id: closeId,
      garment_ids: [],
      collect_cents: 1000,
    },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(picked.ok, true, JSON.stringify(picked));

  // Next UTC day
  tick = DAY_EPOCH + 86_400;
  const nextDay = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.receive",
    {
      lines: [
        {
          service_code: "iron",
          category_code: "shirt",
          unit_price_cents: 800,
          qty: 1,
        },
      ],
      paid_cents: 0,
    },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(nextDay.ok, true);

  const byDate = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "order.list",
    { business_date: BUSINESS_DATE },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(byDate.ok, true);
  if (!byDate.ok) return;
  const dateRows = (byDate.data.result as { orders: readonly ListRow[] }).orders;
  assert.equal(dateRows.length, 2);
  assert.ok(dateRows.every((r) => r.created_at < DAY_EPOCH + 86_400));

  const openOnly = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "order.list",
    { business_date: BUSINESS_DATE, status: "open" },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(openOnly.ok, true);
  if (!openOnly.ok) return;
  const openRows = (openOnly.data.result as { orders: readonly ListRow[] }).orders;
  assert.equal(openRows.length, 1);
  assert.equal(openRows[0]?.order_id, openId);
  assert.equal(openRows[0]?.status, "open");

  const closedOnly = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "order.list",
    { status: "closed" },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(closedOnly.ok, true);
  if (!closedOnly.ok) return;
  const closedRows = (closedOnly.data.result as { orders: readonly ListRow[] }).orders;
  assert.equal(closedRows.length, 1);
  assert.equal(closedRows[0]?.order_id, closeId);
});

test("order.list filters by exact customer_phone", async () => {
  let tick = DAY_EPOCH;
  const { registry, queryRegistry, chainHooks, pendingStore } = buildBus(
    createMemoryOrderStore(),
    () => tick,
  );

  const first = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.receive",
    {
      customer_phone: "13800000111",
      customer_name: "甲",
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
  assert.equal(first.ok, true, JSON.stringify(first));
  if (!first.ok) return;
  const firstId = (first.data.result as { order_id: string }).order_id;

  tick = DAY_EPOCH + 30;
  const second = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.receive",
    {
      customer_phone: "13800000222",
      customer_name: "乙",
      lines: [
        {
          service_code: "dry",
          category_code: "coat",
          unit_price_cents: 2000,
          qty: 1,
        },
      ],
      paid_cents: 0,
    },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(second.ok, true, JSON.stringify(second));
  if (!second.ok) return;

  tick = DAY_EPOCH + 60;
  const third = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.receive",
    {
      customer_phone: "13800000111",
      customer_name: "甲",
      lines: [
        {
          service_code: "iron",
          category_code: "pants",
          unit_price_cents: 800,
          qty: 1,
        },
      ],
      paid_cents: 0,
    },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(third.ok, true, JSON.stringify(third));
  if (!third.ok) return;
  const thirdId = (third.data.result as { order_id: string }).order_id;

  const byPhone = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "order.list",
    { customer_phone: "13800000111", limit: 20 },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(byPhone.ok, true, JSON.stringify(byPhone));
  if (!byPhone.ok) return;

  const body = byPhone.data.result as { orders: readonly ListRow[] };
  assert.equal(body.orders.length, 2);
  assert.equal(body.orders[0]?.order_id, thirdId);
  assert.equal(body.orders[1]?.order_id, firstId);
  assert.ok(body.orders.every((r) => r.customer_phone === "13800000111"));

  const other = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "order.list",
    { customer_phone: "13800000999" },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(other.ok, true);
  if (!other.ok) return;
  assert.deepEqual((other.data.result as { orders: readonly ListRow[] }).orders, []);
});

test("order.list respects limit and rejects invalid limit via schema", async () => {
  const { registry, queryRegistry, chainHooks, pendingStore } = buildBus();

  for (let i = 0; i < 3; i += 1) {
    const recv = await executeCommand(
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
    assert.equal(recv.ok, true);
  }

  const limited = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "order.list",
    { limit: 2 },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(limited.ok, true);
  if (!limited.ok) return;
  assert.equal((limited.data.result as { orders: readonly unknown[] }).orders.length, 2);

  const bad = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "order.list",
    { limit: 51 },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.error.code, "VALIDATION_FAILED");
});
