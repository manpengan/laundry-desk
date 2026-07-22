/**
 * M2 order.get over memory store + query bus (partial pickup load path).
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

function buildBus(orderStore = createMemoryOrderStore()) {
  const { registry, queryRegistry } = createRegisteredM1Bus({
    platform: Object.freeze({
      settings: createMemorySettingsStore(),
      features: createMemoryFeaturesStore(),
      audit: createMemoryAuditQueryStore(),
    }),
    order: Object.freeze({ store: orderStore }),
  });
  const pendingStore = new MemoryPendingActionStore();
  const chainHooks = createDefaultChainHooks({}, pendingStore);
  return { registry, queryRegistry, chainHooks, pendingStore, orderStore };
}

test("query registry includes order.get when order deps present", () => {
  const { queryRegistry } = buildBus();
  const names = queryRegistry.names();
  assert.ok(names.includes("order.get"));
  assert.ok(names.includes("platform.settings.get"));
  const entry = queryRegistry.get("order.get");
  assert.ok(entry);
  assert.equal(entry.definition.name, "order.get");
  assert.ok(entry.handler !== undefined);
});

test("order.get returns summary and garments with unit_price_cents", async () => {
  const { registry, queryRegistry, chainHooks, pendingStore } = buildBus();
  const received = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.receive",
    {
      customer_phone: "13800000111",
      customer_name: "张三",
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
  assert.equal(received.ok, true, JSON.stringify(received));
  if (!received.ok) return;
  const orderId = (received.data.result as { order_id: string }).order_id;

  const result = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "order.get",
    { order_id: orderId },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;

  const data = result.data.result as {
    order_id: string;
    ticket_no: string;
    status: string;
    customer_phone: string | null;
    customer_name: string | null;
    payable_cents: number;
    paid_cents: number;
    balance_cents: number;
    garments: readonly {
      garment_id: string;
      barcode: string;
      status: string;
      line_index: number;
      seq: number;
      unit_price_cents: number;
    }[];
  };

  assert.equal(data.order_id, orderId);
  assert.match(data.ticket_no, /^\d{8}-\d{4}$/u);
  assert.equal(data.status, "open");
  assert.equal(data.customer_phone, "13800000111");
  assert.equal(data.customer_name, "张三");
  assert.equal(data.payable_cents, 3000);
  assert.equal(data.paid_cents, 500);
  assert.equal(data.balance_cents, 2500);
  assert.equal(data.garments.length, 2);
  for (const g of data.garments) {
    assert.equal(typeof g.garment_id, "string");
    assert.equal(typeof g.barcode, "string");
    assert.equal(g.status, "received");
    assert.equal(g.line_index, 0);
    assert.ok(g.seq === 1 || g.seq === 2);
    assert.equal(g.unit_price_cents, 1500);
    assert.ok(Number.isInteger(g.unit_price_cents));
  }
});

test("order.get missing order is RESOURCE_UNAVAILABLE", async () => {
  const { queryRegistry } = buildBus();
  const result = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "order.get",
    { order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "RESOURCE_UNAVAILABLE");
});

test("order.get rejects invalid order_id", async () => {
  const { queryRegistry } = buildBus();
  const result = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "order.get",
    { order_id: "not-a-uuid" },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "VALIDATION_FAILED");
});
