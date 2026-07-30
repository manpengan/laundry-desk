import assert from "node:assert/strict";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import { executeQuery } from "../bus/execute-query.js";
import type { ActorContext } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createMemoryFulfillmentStore } from "../fulfillment/memory-store.js";
import type { FulfillmentWorkbenchRow } from "../fulfillment/types.js";
import { createDefaultChainHooks } from "../handlers/default-chain-hooks.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { MemoryPendingActionStore } from "../pending-actions/store.js";

const GARMENT_A = "11111111-1111-4111-8111-111111111111";
const GARMENT_B = "22222222-2222-4222-8222-222222222222";
const ORDER_ID = "33333333-3333-4333-8333-333333333333";
const FIXED_NOW = 1_722_297_600;

const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_STAFF_A_ID,
});
const CLERK: ActorContext = Object.freeze({
  staffId: DEMO_STAFF_A_ID,
  deviceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  via: "ui",
  permissions: Object.freeze(["order_write"]),
});

function seedRow(
  garmentId: string,
  status: FulfillmentWorkbenchRow["status"],
): FulfillmentWorkbenchRow {
  return Object.freeze({
    garment_id: garmentId,
    order_id: ORDER_ID,
    ticket_no: "20260730-0001",
    barcode: garmentId.slice(0, 8).toUpperCase(),
    customer_name: "张三",
    customer_phone_masked: "13800000111",
    service_code: "wash",
    category_code: "shirt",
    color: "白色",
    brand: null,
    status,
    updated_at: FIXED_NOW - 100,
    incident_count: 0,
  });
}

function buildBus(rows: readonly FulfillmentWorkbenchRow[]) {
  const store = createMemoryFulfillmentStore(
    { garments: rows },
    (() => {
      let cursor = 0;
      return () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++cursor).padStart(12, "0")}`;
    })(),
  );
  const { registry, queryRegistry } = createRegisteredM1Bus({
    fulfillment: Object.freeze({ store, now: () => FIXED_NOW }),
  });
  const pendingStore = new MemoryPendingActionStore();
  return {
    store,
    registry,
    queryRegistry,
    pendingStore,
    chainHooks: createDefaultChainHooks(
      {
        checkPolicy: async () =>
          Object.freeze({
            ok: true as const,
            data: Object.freeze({ allowed: true as const }),
          }),
      },
      pendingStore,
    ),
  };
}

test("registry exposes fulfillment commands with distinct risk gates", () => {
  const bus = buildBus([]);
  assert.equal(bus.registry.get("garment.transition")?.definition.risk, "R2");
  assert.equal(bus.registry.get("garment.bulk_transition")?.definition.risk, "R3");
  assert.equal(bus.registry.get("garment.rework")?.definition.risk, "R3");
  assert.equal(bus.registry.get("garment.incident.record")?.definition.risk, "R3");
  assert.equal(bus.registry.get("garment.mark_lost")?.definition.risk, "R4");
  assert.ok(bus.queryRegistry.get("fulfillment.workbench")?.handler);
});

test("single status flow reaches washing then ready and rejects an invalid jump", async () => {
  const bus = buildBus([seedRow(GARMENT_A, "received")]);
  const first = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "garment.transition",
    { garment_id: GARMENT_A, target_status: "washing" },
    {
      registry: bus.registry,
      actor: CLERK,
      chainHooks: bus.chainHooks,
      pendingStore: bus.pendingStore,
    },
  );
  assert.equal(first.ok, true, JSON.stringify(first));

  const second = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "garment.transition",
    { garment_id: GARMENT_A, target_status: "ready" },
    {
      registry: bus.registry,
      actor: CLERK,
      chainHooks: bus.chainHooks,
      pendingStore: bus.pendingStore,
    },
  );
  assert.equal(second.ok, true, JSON.stringify(second));

  const invalid = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "garment.transition",
    { garment_id: GARMENT_A, target_status: "washing" },
    {
      registry: bus.registry,
      actor: CLERK,
      chainHooks: bus.chainHooks,
      pendingStore: bus.pendingStore,
    },
  );
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, "VALIDATION_FAILED");
});

test("batch is atomic and rework can return to washing", async () => {
  const bus = buildBus([seedRow(GARMENT_A, "washing"), seedRow(GARMENT_B, "washing")]);
  const batch = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "garment.bulk_transition",
    { garment_ids: [GARMENT_A, GARMENT_B], target_status: "ready" },
    {
      registry: bus.registry,
      actor: CLERK,
      chainHooks: bus.chainHooks,
      pendingStore: bus.pendingStore,
    },
  );
  assert.equal(batch.ok, true, JSON.stringify(batch));

  const rework = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "garment.rework",
    { garment_ids: [GARMENT_A], reason: "质检发现污渍" },
    {
      registry: bus.registry,
      actor: CLERK,
      chainHooks: bus.chainHooks,
      pendingStore: bus.pendingStore,
    },
  );
  assert.equal(rework.ok, true, JSON.stringify(rework));

  const washAgain = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "garment.transition",
    { garment_id: GARMENT_A, target_status: "washing" },
    {
      registry: bus.registry,
      actor: CLERK,
      chainHooks: bus.chainHooks,
      pendingStore: bus.pendingStore,
    },
  );
  assert.equal(washAgain.ok, true, JSON.stringify(washAgain));
});

test("incident and loss records are visible without leaking a full phone", async () => {
  const bus = buildBus([seedRow(GARMENT_A, "ready")]);
  const incident = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "garment.incident.record",
    {
      garment_id: GARMENT_A,
      kind: "damage",
      note: "纽扣损坏，已告知客户",
      compensation_cents: 500,
    },
    {
      registry: bus.registry,
      actor: CLERK,
      chainHooks: bus.chainHooks,
      pendingStore: bus.pendingStore,
    },
  );
  assert.equal(incident.ok, true, JSON.stringify(incident));

  const lost = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "garment.mark_lost",
    { garment_id: GARMENT_A, reason: "复核后确认遗失", compensation_cents: 2000 },
    {
      registry: bus.registry,
      actor: CLERK,
      chainHooks: bus.chainHooks,
      pendingStore: bus.pendingStore,
    },
  );
  assert.equal(lost.ok, true, JSON.stringify(lost));

  const listed = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "fulfillment.workbench",
    { statuses: ["lost"], key: "20260730", limit: 10 },
    { registry: bus.queryRegistry, actor: CLERK },
  );
  assert.equal(listed.ok, true, JSON.stringify(listed));
  if (!listed.ok) return;
  const rows = (listed.data.result as { garments: FulfillmentWorkbenchRow[] }).garments;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.status, "lost");
  assert.equal(rows[0]?.incident_count, 2);
  assert.equal(rows[0]?.customer_phone_masked, "138****0111");
  assert.equal(JSON.stringify(rows).includes("13800000111"), false);
});

test("R3 and R4 operations fail closed before confirmation", async () => {
  const bus = buildBus([seedRow(GARMENT_A, "ready"), seedRow(GARMENT_B, "ready")]);
  const chainHooks = createDefaultChainHooks({}, bus.pendingStore);
  const bulk = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "garment.bulk_transition",
    { garment_ids: [GARMENT_A, GARMENT_B], target_status: "racked" },
    {
      registry: bus.registry,
      actor: CLERK,
      chainHooks,
      pendingStore: bus.pendingStore,
    },
  );
  assert.equal(bulk.ok, false);
  if (!bulk.ok) assert.equal(bulk.error.code, "POLICY_CONFIRMATION_REQUIRED");

  const lost = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "garment.mark_lost",
    { garment_id: GARMENT_A, reason: "确认遗失", compensation_cents: 0 },
    {
      registry: bus.registry,
      actor: CLERK,
      chainHooks,
      pendingStore: bus.pendingStore,
    },
  );
  assert.equal(lost.ok, false);
  if (!lost.ok) assert.equal(lost.error.code, "POLICY_STEP_UP_REQUIRED");
});
