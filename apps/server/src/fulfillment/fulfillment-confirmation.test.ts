import assert from "node:assert/strict";
import test from "node:test";

import { executeCommand } from "../bus/executor.js";
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
const G1 = "66666666-6666-4666-8666-666666666666";
const G2 = "77777777-7777-4777-8777-777777777777";
const TENANT: TenantContext = Object.freeze({ orgId: ORG, storeId: STORE, staffId: STAFF });
const ACTOR: ActorContext = Object.freeze({
  staffId: STAFF,
  deviceId: DEVICE,
  via: "ui",
  permissions: Object.freeze(["order_write"]),
});

function garment(id: string, barcode: string, status: FulfillmentWorkbenchRow["status"]) {
  return Object.freeze({
    org_id: ORG,
    store_id: STORE,
    garment_id: id,
    order_id: ORDER,
    ticket_no: "20260812-0001",
    barcode,
    customer_name: "not projected",
    customer_phone_masked: "138****0000",
    service_code: "wash",
    category_code: "shirt",
    color: null,
    brand: null,
    status,
    rack_zone: null,
    rack_slot: null,
    updated_at: 1_700_000_000,
    incident_count: 0,
  }) satisfies FulfillmentWorkbenchRow;
}

function runtime(rows: readonly FulfillmentWorkbenchRow[]) {
  const pending = new MemoryPendingActionStore();
  const store = createMemoryFulfillmentStore({ garments: rows });
  const bus = createRegisteredM1Bus(
    {
      fulfillment: Object.freeze({
        store,
        now: () => 1_700_000_000,
        featureEnabled: async () => true,
      }),
    },
    pending,
  );
  return Object.freeze({ ...bus, pending, store });
}

async function firstHop(
  target: ReturnType<typeof runtime>,
  name: string,
  input: Readonly<Record<string, unknown>>,
) {
  const result = await executeCommand(new FakeSqlClient(), TENANT, name, input, {
    registry: target.registry,
    actor: ACTOR,
    chainHooks: target.chainHooks,
    pendingStore: target.pending,
  });
  assert.equal(result.ok, false);
  if (result.ok) assert.fail("confirmation required");
  const detail = "detail" in result.error ? result.error.detail : undefined;
  assert.equal(detail?.kind, "confirmation");
  if (detail?.kind !== "confirmation") assert.fail("confirmation summary required");
  return detail;
}

test("all existing R3/R4 fulfillment operations expose server-derived WYSIWYS authority", async () => {
  const cases = [
    {
      name: "garment.bulk_transition",
      operation: "bulk_transition",
      rows: [garment(G1, "BC-002", "washing"), garment(G2, "BC-001", "washing")],
      input: { garment_ids: [G1, G2], target_status: "ready", note: "batch note" },
    },
    {
      name: "garment.rework",
      operation: "rework",
      rows: [garment(G1, "BC-001", "ready")],
      input: { garment_ids: [G1], reason: "visible stain" },
    },
    {
      name: "garment.incident.record",
      operation: "incident_record",
      rows: [garment(G1, "BC-001", "ready")],
      input: { garment_id: G1, kind: "damage", note: "button damaged" },
    },
    {
      name: "garment.mark_lost",
      operation: "mark_lost",
      rows: [garment(G1, "BC-001", "ready")],
      input: { garment_id: G1, reason: "confirmed lost", compensation_cents: 100 },
    },
  ] as const;
  for (const entry of cases) {
    const detail = await firstHop(runtime(entry.rows), entry.name, entry.input);
    const summary = detail.summary;
    assert.equal(summary?.kind, "fulfillment_operation", entry.name);
    if (summary?.kind !== "fulfillment_operation") continue;
    assert.equal(summary.operation, entry.operation);
    assert.deepEqual(summary.barcodes, [...summary.barcodes].sort());
    assert.equal(JSON.stringify(summary).includes("not projected"), false);
    assert.match(summary.manifest_digest, /^[a-f0-9]{64}$/u);
  }
});

test("confirmed fulfillment execution rejects authority that changed after preparation", async () => {
  const target = runtime([garment(G1, "BC-001", "washing"), garment(G2, "BC-002", "washing")]);
  const input = Object.freeze({ garment_ids: [G1, G2], target_status: "ready" });
  const detail = await firstHop(target, "garment.bulk_transition", input);
  const changed = await target.store.transition({
    org_id: ORG,
    store_id: STORE,
    garment_ids: Object.freeze([G1]),
    target_status: "ready",
    staff_id: STAFF,
    at: 1_700_000_001,
    reason: null,
  });
  assert.ok(changed);
  const result = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "garment.bulk_transition",
    {},
    {
      registry: target.registry,
      actor: ACTOR,
      chainHooks: target.chainHooks,
      pendingStore: target.pending,
      confirmRef: detail.confirm_ref,
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "VALIDATION_FAILED");
});
