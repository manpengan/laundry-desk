/**
 * M2 skeleton: shift.close + shift.get over memory store + order-backed stats.
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
import { createMemoryShiftStore } from "../shift/memory-store.js";
import { createOrderBackedStatsQuery } from "../stats/memory-source.js";

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

function buildBus(fixedNow = () => DAY_EPOCH) {
  const orderStore = createMemoryOrderStore();
  const statsSource = createOrderBackedStatsQuery(orderStore);
  const shiftStore = createMemoryShiftStore();
  const { registry, queryRegistry } = createRegisteredM1Bus({
    platform: Object.freeze({
      settings: createMemorySettingsStore(),
      features: createMemoryFeaturesStore(),
      audit: createMemoryAuditQueryStore(),
    }),
    order: Object.freeze({ store: orderStore, now: fixedNow }),
    stats: Object.freeze({ source: statsSource }),
    shift: Object.freeze({ store: shiftStore, stats: statsSource, now: fixedNow }),
  });
  const pendingStore = new MemoryPendingActionStore();
  const chainHooks = createDefaultChainHooks({}, pendingStore);
  return { registry, queryRegistry, chainHooks, pendingStore, orderStore, shiftStore };
}

test("command registry includes shift.close when shift deps present", () => {
  const { registry, queryRegistry } = buildBus();
  assert.ok(registry.names().includes("shift.close"));
  assert.ok(queryRegistry.names().includes("shift.get"));
  assert.ok(registry.get("shift.close")?.handler);
  assert.ok(queryRegistry.get("shift.get")?.handler);
  assert.equal(registry.get("shift.close")?.definition.risk, "R2");
  assert.equal(queryRegistry.get("shift.get")?.definition.risk, "R1");
});

test("shift.get returns null when day not closed", async () => {
  const { queryRegistry } = buildBus();
  const listed = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "shift.get",
    { business_date: BUSINESS_DATE },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(listed.ok, true, JSON.stringify(listed));
  if (!listed.ok) return;
  assert.equal(listed.data.result, null);
});

test("shift.close snapshots day stats and shift.get returns the row", async () => {
  const { registry, queryRegistry, chainHooks, pendingStore } = buildBus();

  const received = await executeCommand(
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
  assert.equal(received.ok, true, JSON.stringify(received));

  const closed = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "shift.close",
    {
      business_date: BUSINESS_DATE,
      signature_name: "店员甲",
      note: "晚班交班",
    },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(closed.ok, true, JSON.stringify(closed));
  if (!closed.ok) return;

  const body = closed.data.result as {
    shift_id: string;
    business_date: string;
    closed_at: number;
    order_count: number;
    payable_cents: number;
    paid_cents: number;
    payment_cents: number;
    signature_name: string;
  };
  assert.equal(body.business_date, BUSINESS_DATE);
  assert.equal(body.closed_at, DAY_EPOCH);
  assert.equal(body.order_count, 1);
  assert.equal(body.payable_cents, 3000);
  assert.equal(body.paid_cents, 500);
  assert.equal(body.payment_cents, 0);
  assert.equal(body.signature_name, "店员甲");
  assert.ok(typeof body.shift_id === "string" && body.shift_id.length > 0);

  const got = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "shift.get",
    { business_date: BUSINESS_DATE },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(got.ok, true, JSON.stringify(got));
  if (!got.ok) return;
  const row = got.data.result as { shift_id: string; order_count: number; note: string | null };
  assert.equal(row.shift_id, body.shift_id);
  assert.equal(row.order_count, 1);
  assert.equal(row.note, "晚班交班");
});

test("shift.close rejects second close same day", async () => {
  const { registry, chainHooks, pendingStore } = buildBus();

  const first = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "shift.close",
    { business_date: BUSINESS_DATE, signature_name: "店员甲" },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(first.ok, true, JSON.stringify(first));

  const second = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "shift.close",
    { business_date: BUSINESS_DATE, signature_name: "店员乙" },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.error.code, "IDEMPOTENCY_CONFLICT");
});

test("shift.close rejects empty signature_name", async () => {
  const { registry, chainHooks, pendingStore } = buildBus();
  const closed = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "shift.close",
    { business_date: BUSINESS_DATE, signature_name: "   " },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(closed.ok, false);
  if (closed.ok) return;
  assert.equal(closed.error.code, "VALIDATION_FAILED");
});

test("shift.close zeros when no orders that day", async () => {
  const { registry, chainHooks, pendingStore } = buildBus();
  const closed = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "shift.close",
    { business_date: BUSINESS_DATE, signature_name: "店长" },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(closed.ok, true, JSON.stringify(closed));
  if (!closed.ok) return;
  const body = closed.data.result as {
    order_count: number;
    payable_cents: number;
    paid_cents: number;
    payment_cents: number;
  };
  assert.equal(body.order_count, 0);
  assert.equal(body.payable_cents, 0);
  assert.equal(body.paid_cents, 0);
  assert.equal(body.payment_cents, 0);
});
