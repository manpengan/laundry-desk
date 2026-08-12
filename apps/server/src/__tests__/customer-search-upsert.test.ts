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
  permissions: Object.freeze(["order_write", "staff_read", "customer_read", "customer_write"]),
});

const PRIVACY_ADMIN: ActorContext = Object.freeze({
  ...CLERK,
  permissions: Object.freeze(["order_write", "staff_read", "privacy_admin"]),
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

test("query/command registry includes customer governance names", () => {
  const { registry, queryRegistry } = buildBus();
  assert.ok(queryRegistry.names().includes("customer.search"));
  assert.ok(queryRegistry.names().includes("customer.get"));
  assert.ok(queryRegistry.names().includes("customer.duplicates"));
  assert.ok(queryRegistry.names().includes("customer.privacy.status"));
  assert.ok(queryRegistry.names().includes("customer.privacy.events"));
  assert.ok(registry.names().includes("customer.upsert"));
  assert.ok(registry.names().includes("customer.update"));
  assert.ok(registry.names().includes("customer.merge"));
  assert.ok(registry.names().includes("customer.privacy.export"));
  assert.ok(registry.names().includes("customer.anonymize"));
});

test("customer.search returns only masked phones and no notes", async () => {
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
    customers: readonly {
      phone_masked: string;
      name: string | null;
      customer_id: string;
      note?: unknown;
    }[];
  };
  assert.ok(data.customers.length >= DEMO_CUSTOMERS.length);
  assert.ok(data.customers.some((row) => row.phone_masked === "138****0111"));
  assert.ok(data.customers.some((row) => row.phone_masked === "138****0222"));
  assert.ok(data.customers.every((row) => row.note === undefined));
  assert.equal(JSON.stringify(data).includes("13800000"), false);
  // Demo seed: 00222 has higher updated_at → first
  assert.equal(data.customers[0]?.phone_masked, "138****0222");
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
  const phoneRows = (byPhone.data.result as { customers: { phone_masked: string }[] }).customers;
  assert.equal(phoneRows.length, 1);
  assert.equal(phoneRows[0]?.phone_masked, "138****0111");

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

test("customer.upsert without customer_write is PERMISSION_DENIED", async () => {
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

test("customer detail, duplicate merge and old-phone redirect preserve one authority", async () => {
  const store = createMemoryCustomerStore([]);
  const source = await store.upsert({
    customer_id: "11111111-1111-4111-8111-111111111111",
    phone: "13800000333",
    name: "同名客户",
    note: "旧档案",
    now: 100,
  });
  const target = await store.upsert({
    customer_id: "22222222-2222-4222-8222-222222222222",
    phone: "13800000444",
    name: "同名客户",
    note: "保留档案",
    now: 200,
  });
  const duplicates = await store.findDuplicates(source.customer.customer_id, 20);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0]?.customer_id, target.customer.customer_id);

  const merged = await store.merge({
    source_customer_id: source.customer.customer_id,
    target_customer_id: target.customer.customer_id,
    store_id: DEMO_STORE_ID,
    staff_id: DEMO_STAFF_A_ID,
    now: 300,
  });
  assert.deepEqual(merged, {
    source_customer_id: source.customer.customer_id,
    target_customer_id: target.customer.customer_id,
    relinked_order_count: 0,
  });
  assert.equal(
    (await store.getById(source.customer.customer_id))?.customer_id,
    target.customer.customer_id,
  );
  assert.equal(
    (await store.getByPhone(source.customer.phone))?.customer_id,
    target.customer.customer_id,
  );
  const redirected = await store.upsert({
    phone: source.customer.phone,
    name: "合并后名称",
    now: 400,
  });
  assert.equal(redirected.customer.customer_id, target.customer.customer_id);
  assert.equal(redirected.customer.phone, target.customer.phone);
  assert.equal(redirected.customer.name, "合并后名称");
});

test("customer.update and customer.merge fail closed at R3/R4 policy gates", async () => {
  const { registry, chainHooks } = buildBus();
  const update = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "customer.update",
    {
      customer_id: DEMO_CUSTOMERS[0]!.customer_id,
      expected_version: DEMO_CUSTOMERS[0]!.version,
      note: "仅详情可见",
    },
    {
      registry,
      actor: CLERK,
      chainHooks,
      pendingStore: processPendingActionStore,
      stepUpProofStore: processStepUpProofStore,
    },
  );
  assert.equal(update.ok, false);
  if (!update.ok) assert.equal(update.error.code, "POLICY_CONFIRMATION_REQUIRED");

  const merge = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "customer.merge",
    {
      source_customer_id: DEMO_CUSTOMERS[0]!.customer_id,
      target_customer_id: DEMO_CUSTOMERS[1]!.customer_id,
      reason: "同一客户重复建档",
    },
    {
      registry,
      actor: CLERK,
      chainHooks,
      pendingStore: processPendingActionStore,
      stepUpProofStore: processStepUpProofStore,
    },
  );
  assert.equal(merge.ok, false);
  if (!merge.ok) assert.equal(merge.error.code, "POLICY_STEP_UP_REQUIRED");
});

test("customer privacy lifecycle exports before irreversible anonymization", async () => {
  const store = createMemoryCustomerStore([]);
  const created = await store.upsert({
    customer_id: "33333333-3333-4333-8333-333333333333",
    phone: "13800000333",
    name: "隐私客户",
    note: "仅用于测试",
    now: 100,
  });
  const status = await store.privacyStatus(
    created.customer.customer_id,
    DEMO_STORE_ID,
    DEMO_STAFF_A_ID,
  );
  assert.equal(status?.anonymization_eligible, true);

  const exported = await store.exportPrivacy({
    customer_id: created.customer.customer_id,
    store_id: DEMO_STORE_ID,
    staff_id: DEMO_STAFF_A_ID,
    reason: "customer_request",
    event_id: "44444444-4444-4444-8444-444444444444",
    now: 200,
  });
  assert.equal(exported?.customer.phone, "13800000333");
  assert.equal(exported?.customer.name, "隐私客户");

  const anonymized = await store.anonymize({
    customer_id: created.customer.customer_id,
    store_id: DEMO_STORE_ID,
    staff_id: DEMO_STAFF_A_ID,
    reason: "customer_request",
    event_id: "55555555-5555-4555-8555-555555555555",
    now: 300,
  });
  assert.deepEqual(anonymized, {
    customer_id: created.customer.customer_id,
    affected_order_count: 0,
  });
  assert.equal(await store.getById(created.customer.customer_id), null);
  assert.equal(await store.getByPhone("13800000333"), null);
  assert.deepEqual(await store.search("隐私客户", 20), []);
  assert.deepEqual(
    (await store.listPrivacyEvents(created.customer.customer_id, 20)).map((event) => event.action),
    ["anonymized", "exported"],
  );
});

test("customer privacy R4/R5 commands require privacy admin and step-up", async () => {
  const { registry, chainHooks } = buildBus();
  for (const [name, input] of [
    [
      "customer.privacy.export",
      { customer_id: DEMO_CUSTOMERS[0]!.customer_id, reason: "customer_request" },
    ],
    [
      "customer.anonymize",
      {
        customer_id: DEMO_CUSTOMERS[0]!.customer_id,
        reason: "customer_request",
        confirmation: "ANONYMIZE",
      },
    ],
  ] as const) {
    const denied = await executeCommand(new FakeSqlClient(), TENANT, name, input, {
      registry,
      actor: CLERK,
      chainHooks,
      pendingStore: processPendingActionStore,
      stepUpProofStore: processStepUpProofStore,
    });
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, "PERMISSION_DENIED");

    const result = await executeCommand(new FakeSqlClient(), TENANT, name, input, {
      registry,
      actor: PRIVACY_ADMIN,
      chainHooks,
      pendingStore: processPendingActionStore,
      stepUpProofStore: processStepUpProofStore,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "POLICY_STEP_UP_REQUIRED");
  }
});
