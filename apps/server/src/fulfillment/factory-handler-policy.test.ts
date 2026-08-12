import assert from "node:assert/strict";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
import { MemoryIdempotencyStore } from "../bus/idempotency.js";
import { executeQuery } from "../bus/execute-query.js";
import { INSERT_AUDIT_LOG_SQL } from "../audit/write-audit.js";
import type { ActorContext } from "../bus/types.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { MemoryPendingActionStore } from "../pending-actions/store.js";
import { createMemoryFulfillmentStore } from "./memory-store.js";
import type { FulfillmentWorkbenchRow } from "./types.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const STORE = "22222222-2222-4222-8222-222222222222";
const STAFF = "33333333-3333-4333-8333-333333333333";
const DEVICE = "44444444-4444-4444-8444-444444444444";
const ORDER = "55555555-5555-4555-8555-555555555555";
const GARMENT = "66666666-6666-4666-8666-666666666666";
const GARMENT_2 = "77777777-7777-4777-8777-777777777777";
const BATCH = "88888888-8888-4888-8888-888888888888";
const ATTEMPT = "99999999-9999-4999-8999-999999999999";
const TENANT: TenantContext = Object.freeze({ orgId: ORG, storeId: STORE, staffId: STAFF });

const FACTORY_MUTATIONS: readonly Readonly<{ name: string; input: unknown }>[] = Object.freeze([
  Object.freeze({
    name: "fulfillment.batch.create",
    input: Object.freeze({ factory_code: "FACTORY_A", garment_ids: Object.freeze([GARMENT]) }),
  }),
  Object.freeze({
    name: "fulfillment.batch.cancel",
    input: Object.freeze({
      batch_id: BATCH,
      expected_version: 1,
      reason_code: "operational_error",
    }),
  }),
  Object.freeze({
    name: "fulfillment.handoff.checkpoint.record",
    input: Object.freeze({
      batch_id: BATCH,
      checkpoint: "store_dispatch",
      expected_version: 1,
      garment_ids: Object.freeze([GARMENT]),
      scanned_barcodes: Object.freeze(["BC-001"]),
    }),
  }),
  Object.freeze({
    name: "fulfillment.handoff.discrepancy.resolve",
    input: Object.freeze({
      batch_id: BATCH,
      attempt_id: ATTEMPT,
      expected_version: 1,
      garment_ids: Object.freeze([]),
      reason_code: "recount_verified",
    }),
  }),
  Object.freeze({
    name: "fulfillment.quality_check.record",
    input: Object.freeze({
      batch_id: BATCH,
      expected_version: 1,
      garment_ids: Object.freeze([GARMENT]),
      checks: Object.freeze([
        Object.freeze({ garment_id: GARMENT, outcome: "pass", reason_code: null }),
      ]),
    }),
  }),
]);

const LEGACY_MUTATIONS: readonly Readonly<{ name: string; input: unknown }>[] = Object.freeze([
  Object.freeze({
    name: "garment.transition",
    input: Object.freeze({ garment_id: GARMENT, target_status: "washing" }),
  }),
  Object.freeze({
    name: "garment.bulk_transition",
    input: Object.freeze({
      garment_ids: Object.freeze([GARMENT, GARMENT_2]),
      target_status: "washing",
    }),
  }),
  Object.freeze({
    name: "garment.rack.assign",
    input: Object.freeze({ barcode: "BC-001", rack_zone: "A", rack_slot: "01" }),
  }),
  Object.freeze({
    name: "garment.rework",
    input: Object.freeze({ garment_ids: Object.freeze([GARMENT]), reason: "quality" }),
  }),
  Object.freeze({
    name: "garment.incident.record",
    input: Object.freeze({ garment_id: GARMENT, kind: "damage", note: "damage" }),
  }),
  Object.freeze({
    name: "garment.mark_lost",
    input: Object.freeze({ garment_id: GARMENT, reason: "missing", compensation_cents: 0 }),
  }),
]);

const actor = (deviceId: string | null): ActorContext =>
  Object.freeze({
    staffId: STAFF,
    deviceId,
    via: "ui" as const,
    permissions: Object.freeze([
      "order_write",
      "fulfillment_handoff",
      "fulfillment_qc",
      "fulfillment_reconcile",
    ]),
  });

const garment = (): FulfillmentWorkbenchRow =>
  Object.freeze({
    org_id: ORG,
    store_id: STORE,
    garment_id: GARMENT,
    order_id: ORDER,
    ticket_no: "20260812-0001",
    barcode: "BC-001",
    customer_name: null,
    customer_phone_masked: null,
    service_code: "wash",
    category_code: "shirt",
    color: null,
    brand: null,
    status: "received",
    rack_zone: null,
    rack_slot: null,
    updated_at: 1_700_000_000,
    incident_count: 0,
  });

function bus(enabled: boolean) {
  const pending = new MemoryPendingActionStore();
  const store = createMemoryFulfillmentStore({ garments: Object.freeze([garment()]) });
  const runtime = createRegisteredM1Bus(
    {
      fulfillment: Object.freeze({
        store,
        now: () => 1_700_000_000,
        featureEnabled: async () => enabled,
      }),
    },
    pending,
  );
  return Object.freeze({ ...runtime, pending, store });
}

test("factory mutation requires a valid authenticated device before feature or store access", async () => {
  const runtime = bus(true);
  for (const deviceId of [null, "not-a-uuid"] as const) {
    for (const mutation of FACTORY_MUTATIONS) {
      const result = await executeCommand(
        new FakeSqlClient(),
        TENANT,
        mutation.name,
        mutation.input,
        {
          registry: runtime.registry,
          actor: actor(deviceId),
          chainHooks: runtime.chainHooks,
          pendingStore: runtime.pending,
        },
      );
      assert.equal(result.ok, false, mutation.name);
      if (!result.ok) assert.equal(result.error.code, "INVARIANT_FAILED", mutation.name);
    }
  }
});

test("all fulfillment mutations and queries fail closed with the feature disabled", async () => {
  const runtime = bus(false);
  for (const mutation of [...FACTORY_MUTATIONS, ...LEGACY_MUTATIONS]) {
    const command = await executeCommand(
      new FakeSqlClient(),
      TENANT,
      mutation.name,
      mutation.input,
      {
        registry: runtime.registry,
        actor: actor(DEVICE),
        chainHooks: runtime.chainHooks,
        pendingStore: runtime.pending,
      },
    );
    assert.equal(command.ok, false, mutation.name);
    if (!command.ok) {
      assert.equal(command.error.code, "RESOURCE_UNAVAILABLE", mutation.name);
    }
  }
  for (const queryCase of [
    Object.freeze({ name: "fulfillment.workbench", input: Object.freeze({}) }),
    Object.freeze({ name: "fulfillment.batches.list", input: Object.freeze({}) }),
    Object.freeze({ name: "fulfillment.batch.get", input: Object.freeze({ batch_id: BATCH }) }),
  ]) {
    const query = await executeQuery(new FakeSqlClient(), TENANT, queryCase.name, queryCase.input, {
      registry: runtime.queryRegistry,
      actor: actor(null),
    });
    assert.equal(query.ok, false, queryCase.name);
    if (!query.ok) assert.equal(query.error.code, "RESOURCE_UNAVAILABLE", queryCase.name);
  }
});

test("factory query needs no device and confirmation summary is server-derived without customer PII", async () => {
  const runtime = bus(true);
  const query = await executeQuery(
    new FakeSqlClient(),
    TENANT,
    "fulfillment.batches.list",
    {},
    { registry: runtime.queryRegistry, actor: actor(null) },
  );
  assert.equal(query.ok, true, JSON.stringify(query));
  const first = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "fulfillment.batch.create",
    { factory_code: "FACTORY_A", garment_ids: [GARMENT] },
    {
      registry: runtime.registry,
      actor: actor(DEVICE),
      chainHooks: runtime.chainHooks,
      pendingStore: runtime.pending,
    },
  );
  assert.equal(first.ok, false);
  if (first.ok) return;
  assert.equal(first.error.code, "POLICY_CONFIRMATION_REQUIRED");
  const detail = first.error.detail;
  assert.equal(detail?.kind, "confirmation");
  if (detail?.kind !== "confirmation") return;
  const summary = detail.summary as Readonly<Record<string, unknown>>;
  assert.equal(summary.kind, "factory_handoff");
  assert.equal(summary.operation, "batch_create");
  assert.deepEqual(summary.barcodes, ["BC-001"]);
  assert.equal(JSON.stringify(summary).includes("customer"), false);
});

test("confirmed cancellation retains its controlled reason in the audit authority", async () => {
  const runtime = bus(true);
  const created = await runtime.store.createFactoryBatch({
    org_id: ORG,
    store_id: STORE,
    staff_id: STAFF,
    device_id: DEVICE,
    at: 1_700_000_000,
    factory_code: "FACTORY_A",
    garment_ids: Object.freeze([GARMENT]),
  });
  assert.ok(created);
  const input = Object.freeze({
    batch_id: created.batch_id,
    expected_version: created.version,
    reason_code: "operational_error",
  });
  const first = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "fulfillment.batch.cancel",
    input,
    {
      registry: runtime.registry,
      actor: actor(DEVICE),
      chainHooks: runtime.chainHooks,
      pendingStore: runtime.pending,
    },
  );
  assert.equal(first.ok, false);
  if (first.ok) assert.fail("cancellation confirmation required");
  const detail = "detail" in first.error ? first.error.detail : undefined;
  if (detail?.kind !== "confirmation") {
    assert.fail("cancellation confirmation required");
  }
  const client = new FakeSqlClient();
  const confirmed = await executeCommand(
    client,
    TENANT,
    "fulfillment.batch.cancel",
    {},
    {
      registry: runtime.registry,
      actor: actor(DEVICE),
      chainHooks: runtime.chainHooks,
      pendingStore: runtime.pending,
      confirmRef: detail.confirm_ref,
    },
  );
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
  const audit = client.queries.find((query) => query.sql.includes("INSERT INTO audit_log"));
  assert.equal(JSON.parse(String(audit?.params?.[11])).reason_code, "operational_error");
});

for (const failureSql of [INSERT_AUDIT_LOG_SQL, "COMMIT"] as const) {
  test(`memory factory confirmation rolls back business, pending, and idempotency on ${failureSql === "COMMIT" ? "commit" : "audit"} failure`, async () => {
    const runtime = bus(true);
    const idempotency = new MemoryIdempotencyStore();
    const first = await executeCommand(
      new FakeSqlClient(),
      TENANT,
      "fulfillment.batch.create",
      { factory_code: "FACTORY_A", garment_ids: [GARMENT] },
      {
        registry: runtime.registry,
        actor: actor(DEVICE),
        chainHooks: runtime.chainHooks,
        pendingStore: runtime.pending,
        idempotencyStore: idempotency,
        idempotencyKey: "factory-uow-create",
      },
    );
    assert.equal(first.ok, false);
    if (first.ok) assert.fail("factory confirmation required");
    const detail = "detail" in first.error ? first.error.detail : undefined;
    if (detail?.kind !== "confirmation") {
      assert.fail("factory confirmation required");
    }
    const confirmRef = detail.confirm_ref;
    const failedClient = new FakeSqlClient();
    failedClient.failOn(failureSql);
    const failed = await executeCommand(
      failedClient,
      TENANT,
      "fulfillment.batch.create",
      {},
      {
        registry: runtime.registry,
        actor: actor(DEVICE),
        chainHooks: runtime.chainHooks,
        pendingStore: runtime.pending,
        idempotencyStore: idempotency,
        idempotencyKey: "factory-uow-create",
        confirmRef,
      },
    );
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.error.code, "TRANSACTION_FAILED");
    const rolledBack = await runtime.store.listFactoryBatches(ORG, STORE, { limit: 20 });
    assert.equal(rolledBack.batches.length, 0);
    assert.equal(rolledBack.eligible_garments.length, 1);
    assert.equal(runtime.pending.get(confirmRef)?.status, "pending");
    assert.equal(idempotency.size(), 0);

    const retried = await executeCommand(
      new FakeSqlClient(),
      TENANT,
      "fulfillment.batch.create",
      {},
      {
        registry: runtime.registry,
        actor: actor(DEVICE),
        chainHooks: runtime.chainHooks,
        pendingStore: runtime.pending,
        idempotencyStore: idempotency,
        idempotencyKey: "factory-uow-create",
        confirmRef,
      },
    );
    assert.equal(retried.ok, true, JSON.stringify(retried));
    assert.equal(runtime.pending.get(confirmRef)?.status, "consumed");
    assert.equal(idempotency.size(), 1);
  });
}
