/**
 * M2: shift.close (R3 confirm) + shift.get over memory store + order-backed stats.
 */

import assert from "node:assert/strict";
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
import {
  createMemoryAuditQueryStore,
  createMemoryFeaturesStore,
  createMemorySettingsStore,
} from "../platform/index.js";
import { MemoryPendingActionStore } from "../pending-actions/store.js";
import type { ShiftHandlerDeps } from "../shift/handlers.js";
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
  permissions: Object.freeze(["order_write", "staff_read", "shift_close", "accounting_read"]),
});

/** Fixed: 2024-07-22T00:00:00.000Z */
const DAY_EPOCH = 1_721_606_400;
const BUSINESS_DATE = "2024-07-22";

function buildBus(
  fixedNow = () => DAY_EPOCH,
  lockBusinessDay?: ShiftHandlerDeps["lockBusinessDay"],
) {
  const orderStore = createMemoryOrderStore();
  const statsSource = createOrderBackedStatsQuery(orderStore);
  const shiftStore = createMemoryShiftStore();
  const { registry, queryRegistry } = createRegisteredM1Bus({
    platform: Object.freeze({
      settings: createMemorySettingsStore(),
      features: createMemoryFeaturesStore(),
      audit: createMemoryAuditQueryStore(),
    }),
    order: Object.freeze({ store: orderStore, catalog: createMemoryCatalogStore(), now: fixedNow }),
    stats: Object.freeze({ source: statsSource }),
    shift: Object.freeze({
      store: shiftStore,
      stats: statsSource,
      now: fixedNow,
      ...(lockBusinessDay === undefined ? {} : { lockBusinessDay }),
    }),
  });
  const pendingStore = new MemoryPendingActionStore();
  const chainHooks = createDefaultChainHooks({}, pendingStore);
  return { registry, queryRegistry, chainHooks, pendingStore, orderStore, shiftStore };
}

/** R3: first hop creates confirm card; second hop with confirm_ref executes. */
async function closeWithConfirm(
  bus: ReturnType<typeof buildBus>,
  input: Readonly<{
    business_date: string;
    signature_name: string;
    counted_cash_cents?: number;
    retained_float_cents?: number;
    note?: string;
  }>,
): Promise<Awaited<ReturnType<typeof executeCommand>>> {
  const closeInput = Object.freeze({
    counted_cash_cents: 0,
    retained_float_cents: 0,
    ...input,
  });
  const first = await executeCommand(new FakeSqlClient(), TENANT, "shift.close", closeInput, {
    registry: bus.registry,
    actor: CLERK,
    chainHooks: bus.chainHooks,
    pendingStore: bus.pendingStore,
  });
  if (first.ok) {
    return first;
  }
  assert.equal(first.error.code, "POLICY_CONFIRMATION_REQUIRED", JSON.stringify(first));
  const detail = "detail" in first.error ? first.error.detail : undefined;
  assert.equal(detail?.kind, "confirmation");
  if (detail?.kind !== "confirmation") {
    assert.fail("expected confirmation detail");
  }
  return executeCommand(
    new FakeSqlClient(),
    TENANT,
    "shift.close",
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

test("command registry includes shift.close when shift deps present", () => {
  const { registry, queryRegistry } = buildBus();
  assert.ok(registry.names().includes("shift.close"));
  assert.ok(queryRegistry.names().includes("shift.get"));
  assert.ok(queryRegistry.names().includes("shift.history"));
  assert.ok(registry.get("shift.close")?.handler);
  assert.ok(queryRegistry.get("shift.get")?.handler);
  assert.equal(registry.get("shift.close")?.definition.risk, "R3");
  assert.equal(queryRegistry.get("shift.get")?.definition.risk, "R1");
});

test("shift.history returns frozen closings newest first within the bounded range", async () => {
  const bus = buildBus();
  const first = await closeWithConfirm(bus, {
    business_date: "2024-07-21",
    signature_name: "早班",
    counted_cash_cents: 100,
  });
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = await closeWithConfirm(bus, {
    business_date: BUSINESS_DATE,
    signature_name: "晚班",
    counted_cash_cents: 200,
  });
  assert.equal(second.ok, true, JSON.stringify(second));

  const history = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "shift.history",
    { date_from: "2024-07-01", date_to: BUSINESS_DATE, limit: 10 },
    { registry: bus.queryRegistry, actor: CLERK },
  );
  assert.equal(history.ok, true, JSON.stringify(history));
  if (!history.ok) return;
  const rows = (history.data.result as { shifts: { business_date: string }[] }).shifts;
  assert.deepEqual(
    rows.map((row) => row.business_date),
    [BUSINESS_DATE, "2024-07-21"],
  );
});

test("closing a historical day never carries float backward from a future closing", async () => {
  const bus = buildBus();
  const future = await closeWithConfirm(bus, {
    business_date: "2024-07-31",
    signature_name: "未来班次",
    retained_float_cents: 700,
  });
  assert.equal(future.ok, true, JSON.stringify(future));

  const historical = await closeWithConfirm(bus, {
    business_date: "2024-07-30",
    signature_name: "历史班次",
    counted_cash_cents: 0,
  });
  assert.equal(historical.ok, true, JSON.stringify(historical));
  if (!historical.ok) return;
  const result = historical.data.result as {
    opening_float_cents: number;
    expected_cash_cents: number;
    cash_difference_cents: number;
  };
  assert.equal(result.opening_float_cents, 0);
  assert.equal(result.expected_cash_cents, 0);
  assert.equal(result.cash_difference_cents, 0);
});

test("shift.close without confirm_ref is blocked with POLICY_CONFIRMATION_REQUIRED", async () => {
  const { registry, chainHooks, pendingStore } = buildBus();
  const result = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "shift.close",
    {
      business_date: BUSINESS_DATE,
      counted_cash_cents: 0,
      retained_float_cents: 0,
      signature_name: "店员甲",
    },
    { registry, actor: CLERK, chainHooks, pendingStore },
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "POLICY_CONFIRMATION_REQUIRED");
    const detail = "detail" in result.error ? result.error.detail : undefined;
    assert.equal(detail?.kind, "confirmation");
    if (detail?.kind === "confirmation") {
      assert.match(detail.confirm_ref, /^[0-9a-f-]{36}$/i);
    }
  }
});

test("shift.close acquires the same business-day lock before freezing stats", async () => {
  const calls: string[] = [];
  const bus = buildBus(undefined, async (_client, tenant, businessDate) => {
    assert.equal(tenant.storeId, TENANT.storeId);
    assert.equal(businessDate, BUSINESS_DATE);
    calls.push("lock");
  });
  const result = await closeWithConfirm(bus, {
    business_date: BUSINESS_DATE,
    signature_name: "店长",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(calls, ["lock"]);
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

test("shift reads reject a staff actor without accounting permission", async () => {
  const { queryRegistry } = buildBus();
  const actor = Object.freeze({
    ...CLERK,
    permissions: Object.freeze(["order_write", "staff_read"]),
  });
  for (const [name, input] of [
    ["shift.get", { business_date: BUSINESS_DATE }],
    ["shift.history", { date_from: BUSINESS_DATE, date_to: BUSINESS_DATE }],
  ] as const) {
    const result = await executeQuery(new FakeSqlClient(), TENANT, name, input, {
      registry: queryRegistry,
      actor,
    });
    assert.equal(result.ok, false, name);
    if (!result.ok) assert.equal(result.error.code, "PERMISSION_DENIED", name);
  }
});

test("shift.close snapshots day stats and shift.get returns the row", async () => {
  const bus = buildBus();

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
    {
      registry: bus.registry,
      actor: CLERK,
      chainHooks: bus.chainHooks,
      pendingStore: bus.pendingStore,
    },
  );
  assert.equal(received.ok, true, JSON.stringify(received));

  const closed = await closeWithConfirm(bus, {
    business_date: BUSINESS_DATE,
    signature_name: "店员甲",
    note: "晚班交班",
  });
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
  assert.equal(body.payment_cents, 500);
  assert.equal(body.signature_name, "店员甲");
  assert.ok(typeof body.shift_id === "string" && body.shift_id.length > 0);

  const got = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "shift.get",
    { business_date: BUSINESS_DATE },
    { registry: bus.queryRegistry, actor: CLERK },
  );
  assert.equal(got.ok, true, JSON.stringify(got));
  if (!got.ok) return;
  const row = got.data.result as { shift_id: string; order_count: number; note: string | null };
  assert.equal(row.shift_id, body.shift_id);
  assert.equal(row.order_count, 1);
  assert.equal(row.note, "晚班交班");
});

test("shift.close excludes draft and cancelled orders from its day snapshot", async () => {
  const bus = buildBus();
  const draft = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.hold",
    {
      lines: [
        {
          service_code: "dry",
          category_code: "coat",
          unit_price_cents: 2500,
          qty: 1,
        },
      ],
    },
    {
      registry: bus.registry,
      actor: CLERK,
      chainHooks: bus.chainHooks,
      pendingStore: bus.pendingStore,
    },
  );
  assert.equal(draft.ok, true, JSON.stringify(draft));

  const active = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.receive",
    {
      lines: [
        {
          service_code: "wash",
          category_code: "shirt",
          unit_price_cents: 1500,
          qty: 1,
        },
      ],
      paid_cents: 500,
    },
    {
      registry: bus.registry,
      actor: CLERK,
      chainHooks: bus.chainHooks,
      pendingStore: bus.pendingStore,
    },
  );
  assert.equal(active.ok, true, JSON.stringify(active));

  const receivedToCancel = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.receive",
    {
      lines: [
        {
          service_code: "wash",
          category_code: "shirt",
          unit_price_cents: 2200,
          qty: 1,
        },
      ],
    },
    {
      registry: bus.registry,
      actor: CLERK,
      chainHooks: bus.chainHooks,
      pendingStore: bus.pendingStore,
    },
  );
  assert.equal(receivedToCancel.ok, true, JSON.stringify(receivedToCancel));
  if (!receivedToCancel.ok) return;
  const cancelledOrderId = (receivedToCancel.data.result as { order_id: string }).order_id;
  const cancelled = await bus.orderStore.cancelOpenOrder?.(
    TENANT.orgId,
    TENANT.storeId,
    cancelledOrderId,
    "customer changed mind",
    TENANT.staffId,
    DAY_EPOCH,
    BUSINESS_DATE,
  );
  assert.equal(cancelled?.status, "cancelled");

  const closed = await closeWithConfirm(bus, {
    business_date: BUSINESS_DATE,
    signature_name: "店长",
  });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  if (!closed.ok) return;
  const result = closed.data.result as {
    order_count: number;
    payable_cents: number;
    paid_cents: number;
    payment_cents: number;
  };
  assert.deepEqual(
    {
      order_count: result.order_count,
      payable_cents: result.payable_cents,
      paid_cents: result.paid_cents,
      payment_cents: result.payment_cents,
    },
    {
      order_count: 1,
      payable_cents: 1500,
      paid_cents: 500,
      payment_cents: 500,
    },
  );
});

test("shift.close signs a reversal of a cash refund positively", async () => {
  const bus = buildBus();
  const received = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "order.receive",
    {
      lines: [{ service_code: "wash", category_code: "shirt", qty: 1 }],
      initial_payment: { amount_cents: 800, method: "cash" },
    },
    {
      registry: bus.registry,
      actor: CLERK,
      chainHooks: bus.chainHooks,
      pendingStore: bus.pendingStore,
    },
  );
  assert.equal(received.ok, true, JSON.stringify(received));
  if (!received.ok) return;
  const orderId = (received.data.result as { order_id: string }).order_id;
  const original = (
    await bus.orderStore.listPayments?.(TENANT.orgId, TENANT.storeId, orderId)
  )?.[0];
  assert.ok(original);
  const refund = await bus.orderStore.appendRefund?.({
    org_id: TENANT.orgId,
    store_id: TENANT.storeId,
    order_id: orderId,
    amount_cents: 300,
    expected_method: original.method,
    ref_payment_id: original.payment_id,
    reason: "partial refund before cancellation",
    staff_id: TENANT.staffId,
    at: DAY_EPOCH,
    business_date: BUSINESS_DATE,
  });
  assert.ok(refund);
  const cancelled = await bus.orderStore.cancelOpenOrder?.(
    TENANT.orgId,
    TENANT.storeId,
    orderId,
    "customer cancelled",
    TENANT.staffId,
    DAY_EPOCH,
    BUSINESS_DATE,
  );
  assert.equal(cancelled?.status, "cancelled");

  const closed = await closeWithConfirm(bus, {
    business_date: BUSINESS_DATE,
    signature_name: "店长",
  });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  if (!closed.ok) return;
  const result = closed.data.result as {
    expected_cash_cents: number;
    cash_difference_cents: number;
  };
  assert.equal(result.expected_cash_cents, 0);
  assert.equal(result.cash_difference_cents, 0);
});

test("shift.close rejects second close same day", async () => {
  const bus = buildBus();

  const first = await closeWithConfirm(bus, {
    business_date: BUSINESS_DATE,
    signature_name: "店员甲",
  });
  assert.equal(first.ok, true, JSON.stringify(first));

  const second = await closeWithConfirm(bus, {
    business_date: BUSINESS_DATE,
    signature_name: "店员乙",
  });
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.error.code, "IDEMPOTENCY_CONFLICT");
});

test("shift.close rejects empty signature_name", async () => {
  const bus = buildBus();
  // Validation runs after R3 confirm card is created; resume still fails validation.
  const closed = await closeWithConfirm(bus, {
    business_date: BUSINESS_DATE,
    signature_name: "   ",
  });
  assert.equal(closed.ok, false);
  if (closed.ok) return;
  assert.equal(closed.error.code, "VALIDATION_FAILED");
});

test("shift.close zeros when no orders that day", async () => {
  const bus = buildBus();
  const closed = await closeWithConfirm(bus, {
    business_date: BUSINESS_DATE,
    signature_name: "店长",
  });
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
