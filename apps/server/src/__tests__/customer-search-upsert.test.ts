/**
 * M2 customer.search / customer.upsert over memory store + bus.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import { executeQuery } from "../bus/execute-query.js";
import type { ActorContext } from "../bus/types.js";
import { createMemoryCustomerStore, DEMO_CUSTOMERS } from "../customer/memory-store.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import {
  createMemoryAuditQueryStore,
  createMemoryFeaturesStore,
  createMemorySettingsStore,
} from "../platform/index.js";
import { processPendingActionStore } from "../pending-actions/process-store.js";
import { processStepUpProofStore } from "../policy/step-up-proof-store.js";

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

function buildBus(store = createMemoryCustomerStore()) {
  const { registry, queryRegistry, chainHooks } = createRegisteredM1Bus({
    platform: Object.freeze({
      settings: createMemorySettingsStore(),
      features: createMemoryFeaturesStore(),
      audit: createMemoryAuditQueryStore(),
    }),
    customer: Object.freeze({ store }),
  });
  return { registry, queryRegistry, chainHooks, store };
}

test("query/command registry includes customer skeleton names", () => {
  const { registry, queryRegistry } = buildBus();
  assert.ok(queryRegistry.names().includes("customer.search"));
  assert.ok(registry.names().includes("customer.upsert"));
});

test("customer.search returns demo seed phones newest first", async () => {
  const { queryRegistry } = buildBus();
  const result = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "customer.search",
    {},
    { registry: queryRegistry, actor: CLERK },
  );

  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  const data = result.data.result as {
    customers: readonly { phone: string; name: string | null; customer_id: string }[];
  };
  assert.ok(data.customers.length >= DEMO_CUSTOMERS.length);
  assert.ok(data.customers.some((row) => row.phone === "13800000111"));
  assert.ok(data.customers.some((row) => row.phone === "13800000222"));
  // Demo seed: 00222 has higher updated_at → first
  assert.equal(data.customers[0]?.phone, "13800000222");
});

test("customer.search filters by phone prefix and name", async () => {
  const { queryRegistry } = buildBus();
  const byPhone = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "customer.search",
    { query: "138000001" },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(byPhone.ok, true);
  if (!byPhone.ok) return;
  const phoneRows = (byPhone.data.result as { customers: { phone: string }[] }).customers;
  assert.equal(phoneRows.length, 1);
  assert.equal(phoneRows[0]?.phone, "13800000111");

  const byName = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "customer.search",
    { query: "李" },
    { registry: queryRegistry, actor: CLERK },
  );
  assert.equal(byName.ok, true);
  if (!byName.ok) return;
  const nameRows = (byName.data.result as { customers: { name: string | null }[] }).customers;
  assert.equal(nameRows.length, 1);
  assert.equal(nameRows[0]?.name, "李四");
});

test("customer.upsert creates then updates by phone", async () => {
  const { registry, chainHooks, store } = buildBus(createMemoryCustomerStore([]));
  const createRes = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "customer.upsert",
    { phone: "13800000333", name: "王五" },
    {
      registry,
      actor: CLERK,
      chainHooks,
      pendingStore: processPendingActionStore,
      stepUpProofStore: processStepUpProofStore,
    },
  );
  assert.equal(createRes.ok, true, JSON.stringify(createRes));
  if (!createRes.ok) return;
  const created = createRes.data.result as {
    customer_id: string;
    phone: string;
    name: string | null;
    created: boolean;
  };
  assert.equal(created.created, true);
  assert.equal(created.phone, "13800000333");
  assert.equal(created.name, "王五");

  const updateRes = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "customer.upsert",
    { phone: "13800000333", name: "王五改" },
    {
      registry,
      actor: CLERK,
      chainHooks,
      pendingStore: processPendingActionStore,
      stepUpProofStore: processStepUpProofStore,
    },
  );
  assert.equal(updateRes.ok, true, JSON.stringify(updateRes));
  if (!updateRes.ok) return;
  const updated = updateRes.data.result as {
    customer_id: string;
    name: string | null;
    created: boolean;
  };
  assert.equal(updated.created, false);
  assert.equal(updated.customer_id, created.customer_id);
  assert.equal(updated.name, "王五改");

  const found = await store.getByPhone("13800000333");
  assert.equal(found?.name, "王五改");
});

test("customer.upsert without order_write is PERMISSION_DENIED", async () => {
  const { registry, chainHooks } = buildBus();
  const noWrite: ActorContext = Object.freeze({
    ...CLERK,
    permissions: Object.freeze(["staff_read"]),
  });
  const result = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "customer.upsert",
    { phone: "13800000999" },
    {
      registry,
      actor: noWrite,
      chainHooks,
      pendingStore: processPendingActionStore,
      stepUpProofStore: processStepUpProofStore,
    },
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "PERMISSION_DENIED");
});
