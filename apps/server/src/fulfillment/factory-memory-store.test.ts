import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryFulfillmentStore } from "./memory-store.js";
import type { FactoryHandoffStore } from "./factory-types.js";
import type { FulfillmentStore, FulfillmentWorkbenchRow } from "./types.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const STORE = "22222222-2222-4222-8222-222222222222";
const STAFF = "33333333-3333-4333-8333-333333333333";
const DEVICE = "44444444-4444-4444-8444-444444444444";
const ORDER = "55555555-5555-4555-8555-555555555555";
const G1 = "66666666-6666-4666-8666-666666666666";
const G2 = "77777777-7777-4777-8777-777777777777";
const AT = 1_700_000_000;

function row(
  garmentId: string,
  barcode: string,
  overrides: Partial<FulfillmentWorkbenchRow> = {},
): FulfillmentWorkbenchRow {
  return Object.freeze({
    org_id: ORG,
    store_id: STORE,
    garment_id: garmentId,
    order_id: ORDER,
    ticket_no: "20260812-0001",
    barcode,
    customer_name: null,
    customer_phone_masked: null,
    service_code: "wash",
    category_code: "shirt",
    color: null,
    brand: null,
    status: "received",
    rack_zone: null,
    rack_slot: null,
    updated_at: AT,
    incident_count: 0,
    ...overrides,
  });
}

function store(seed = [row(G1, "BC-001"), row(G2, "BC-002")]): FulfillmentStore {
  let cursor = 0;
  return createMemoryFulfillmentStore(
    { garments: Object.freeze(seed) },
    () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++cursor).padStart(12, "0")}`,
  );
}

const scope = Object.freeze({
  org_id: ORG,
  store_id: STORE,
  staff_id: STAFF,
  device_id: DEVICE,
  at: AT,
});

async function createBatch(target: FactoryHandoffStore) {
  const created = await target.createFactoryBatch({
    ...scope,
    factory_code: "FACTORY_A",
    garment_ids: Object.freeze([G1, G2]),
  });
  assert.ok(created);
  return created;
}

test("memory handoff keeps a discrepant attempt immutable and advances only after reconciliation", async () => {
  const target = store();
  const created = await createBatch(target);
  const attempt = await target.recordFactoryCheckpoint({
    ...scope,
    batch_id: created.batch_id,
    checkpoint: "store_dispatch",
    expected_version: created.version,
    garment_ids: Object.freeze([G1, G2]),
    scanned_barcodes: Object.freeze(["BC-001", "OUTSIDE"]),
  });
  assert.deepEqual(
    attempt && {
      status: attempt.status,
      version: attempt.version,
      outcome: attempt.outcome,
      matched: attempt.matched_count,
      missing: attempt.missing_count,
      unexpected: attempt.unexpected_count,
    },
    {
      status: "packing",
      version: 1,
      outcome: "discrepancy",
      matched: 1,
      missing: 1,
      unexpected: 1,
    },
  );
  assert.equal(
    (await target.getFactoryBatch(ORG, STORE, created.batch_id))?.manifest[0]?.custody_state,
    "store",
  );
  const bypass = await target.recordFactoryCheckpoint({
    ...scope,
    at: AT + 1,
    batch_id: created.batch_id,
    checkpoint: "store_dispatch",
    expected_version: created.version,
    garment_ids: Object.freeze([G1, G2]),
    scanned_barcodes: Object.freeze(["BC-001", "BC-002"]),
  });
  assert.equal(bypass, null);
  assert.equal(
    (await target.getFactoryBatch(ORG, STORE, created.batch_id))?.latest_attempt?.attempt_id,
    attempt?.attempt_id,
  );

  const resolved = await target.resolveFactoryDiscrepancy({
    ...scope,
    at: AT + 1,
    batch_id: created.batch_id,
    attempt_id: attempt!.attempt_id,
    expected_version: created.version,
    garment_ids: Object.freeze([G2]),
    reason_code: "exception_accepted",
  });
  assert.equal(resolved?.status, "store_dispatched");
  assert.equal(resolved?.version, 2);
  const detail = await target.getFactoryBatch(ORG, STORE, created.batch_id);
  assert.equal(detail?.batch.exception_count, 1);
  assert.equal(
    detail?.manifest.find((item) => item.garment_id === G1)?.custody_state,
    "to_factory",
  );
  assert.equal(detail?.manifest.find((item) => item.garment_id === G2)?.custody_state, "exception");
  assert.equal(detail?.manifest.find((item) => item.garment_id === G2)?.member_state, "exception");
  const nextSummary = await target.prepareFactoryConfirmation({
    operation: "checkpoint_record",
    input: {
      ...scope,
      batch_id: created.batch_id,
      checkpoint: "factory_receive",
      expected_version: resolved!.version,
      garment_ids: Object.freeze([G1]),
      scanned_barcodes: Object.freeze(["BC-001"]),
    },
  });
  assert.deepEqual(nextSummary?.barcodes, ["BC-001"]);
  assert.equal(nextSummary?.counts.manifest_count, 1);
  assert.equal(
    await target.prepareFactoryConfirmation({
      operation: "batch_cancel",
      input: {
        ...scope,
        batch_id: created.batch_id,
        expected_version: resolved!.version,
        reason_code: "operational_error",
      },
    }),
    null,
  );
});

test("memory handoff rejects an unexpected-only discrepancy with no matched active member", async () => {
  const target = store();
  const created = await createBatch(target);
  const attempt = await target.recordFactoryCheckpoint({
    ...scope,
    batch_id: created.batch_id,
    checkpoint: "store_dispatch",
    expected_version: created.version,
    garment_ids: Object.freeze([G1, G2]),
    scanned_barcodes: Object.freeze(["OUTSIDE"]),
  });
  assert.equal(attempt?.outcome, "discrepancy");
  assert.equal(
    (await target.getFactoryBatch(ORG, STORE, created.batch_id))?.latest_attempt?.attempt_id,
    attempt?.attempt_id,
  );
  const resolved = await target.resolveFactoryDiscrepancy({
    ...scope,
    batch_id: created.batch_id,
    attempt_id: attempt!.attempt_id,
    expected_version: created.version,
    garment_ids: Object.freeze([G1, G2]),
    reason_code: "exception_accepted",
  });
  assert.equal(resolved, null);
  assert.equal(
    (await target.getFactoryBatch(ORG, STORE, created.batch_id))?.batch.status,
    "packing",
  );
});

test("memory unresolved discrepancy blocks QC and exact rescanning until R4 resolution", async () => {
  const target = store();
  let batch = await createBatch(target);
  for (const checkpoint of ["store_dispatch", "factory_receive"] as const) {
    const advanced = await target.recordFactoryCheckpoint({
      ...scope,
      batch_id: batch.batch_id,
      checkpoint,
      expected_version: batch.version,
      garment_ids: Object.freeze([G1, G2]),
      scanned_barcodes: Object.freeze(["BC-001", "BC-002"]),
    });
    assert.ok(advanced);
    batch = advanced;
  }
  const firstQc = await target.recordFactoryQuality({
    ...scope,
    batch_id: batch.batch_id,
    expected_version: batch.version,
    garment_ids: Object.freeze([G1, G2]),
    checks: Object.freeze([
      Object.freeze({ garment_id: G1, outcome: "pass" as const, reason_code: null }),
      Object.freeze({ garment_id: G2, outcome: "pass" as const, reason_code: null }),
    ]),
  });
  assert.ok(firstQc);
  batch = firstQc;
  const attempt = await target.recordFactoryCheckpoint({
    ...scope,
    batch_id: batch.batch_id,
    checkpoint: "factory_dispatch",
    expected_version: batch.version,
    garment_ids: Object.freeze([G1, G2]),
    scanned_barcodes: Object.freeze(["BC-001", "OUTSIDE"]),
  });
  assert.equal(attempt?.outcome, "discrepancy");
  assert.equal(
    (await target.getFactoryBatch(ORG, STORE, batch.batch_id))?.latest_attempt?.attempt_id,
    attempt?.attempt_id,
  );
  const secondQc = await target.recordFactoryQuality({
    ...scope,
    batch_id: batch.batch_id,
    expected_version: batch.version,
    garment_ids: Object.freeze([G1]),
    checks: Object.freeze([
      Object.freeze({ garment_id: G1, outcome: "pass" as const, reason_code: null }),
    ]),
  });
  assert.equal(secondQc, null);
  const exactRetry = await target.recordFactoryCheckpoint({
    ...scope,
    batch_id: batch.batch_id,
    checkpoint: "factory_dispatch",
    expected_version: batch.version,
    garment_ids: Object.freeze([G1, G2]),
    scanned_barcodes: Object.freeze(["BC-001", "BC-002"]),
  });
  assert.equal(exactRetry, null);
  const resolved = await target.resolveFactoryDiscrepancy({
    ...scope,
    batch_id: batch.batch_id,
    attempt_id: attempt!.attempt_id,
    expected_version: batch.version,
    garment_ids: Object.freeze([G2]),
    reason_code: "exception_accepted",
  });
  assert.equal(resolved?.status, "factory_dispatched");
  assert.equal(
    (await target.getFactoryBatch(ORG, STORE, batch.batch_id))?.batch.status,
    "factory_dispatched",
  );
});

test("memory mark_lost requires a device for an exception member and does not block its batch", async () => {
  const target = store();
  let batch = await createBatch(target);
  const attempt = await target.recordFactoryCheckpoint({
    ...scope,
    batch_id: batch.batch_id,
    checkpoint: "store_dispatch",
    expected_version: batch.version,
    garment_ids: Object.freeze([G1, G2]),
    scanned_barcodes: Object.freeze(["BC-001"]),
  });
  assert.ok(attempt);
  const directLoss = await target.transition({
    org_id: ORG,
    store_id: STORE,
    garment_ids: Object.freeze([G2]),
    target_status: "lost",
    staff_id: STAFF,
    device_id: DEVICE,
    at: AT + 5,
    reason: "unresolved missing",
    confirmation_operation: "mark_lost",
  });
  assert.equal(directLoss, null);
  assert.equal(
    (await target.getFactoryBatch(ORG, STORE, batch.batch_id))?.batch.version,
    batch.version,
  );
  const reconciled = await target.resolveFactoryDiscrepancy({
    ...scope,
    batch_id: batch.batch_id,
    attempt_id: attempt.attempt_id,
    expected_version: batch.version,
    garment_ids: Object.freeze([G2]),
    reason_code: "exception_accepted",
  });
  assert.ok(reconciled);
  batch = reconciled;
  const lossInput = Object.freeze({
    org_id: ORG,
    store_id: STORE,
    garment_ids: Object.freeze([G2]),
    target_status: "lost" as const,
    staff_id: STAFF,
    at: AT + 10,
    reason: "confirmed missing",
    confirmation_operation: "mark_lost" as const,
  });
  assert.equal(await target.transition({ ...lossInput, device_id: null }), null);
  const lost = await target.transition({ ...lossInput, device_id: DEVICE });
  assert.equal(lost?.length, 1);
  const afterLoss = await target.getFactoryBatch(ORG, STORE, batch.batch_id);
  assert.equal(
    afterLoss?.manifest.find((item) => item.garment_id === G2)?.custody_state,
    "exception",
  );
  assert.equal(afterLoss?.manifest.find((item) => item.garment_id === G2)?.status, "lost");
  assert.equal(afterLoss?.batch.version, batch.version + 1);
  const received = await target.recordFactoryCheckpoint({
    ...scope,
    batch_id: batch.batch_id,
    checkpoint: "factory_receive",
    expected_version: afterLoss!.batch.version,
    garment_ids: Object.freeze([G1]),
    scanned_barcodes: Object.freeze(["BC-001"]),
  });
  assert.equal(received?.status, "factory_received");
});

test("memory mark_lost keeps a terminal batch authority immutable", async () => {
  const target = store();
  let batch = await createBatch(target);
  for (const checkpoint of ["store_dispatch", "factory_receive"] as const) {
    const advanced = await target.recordFactoryCheckpoint({
      ...scope,
      batch_id: batch.batch_id,
      checkpoint,
      expected_version: batch.version,
      garment_ids: Object.freeze([G1, G2]),
      scanned_barcodes: Object.freeze(["BC-001", "BC-002"]),
    });
    assert.ok(advanced);
    batch = advanced;
  }
  const quality = await target.recordFactoryQuality({
    ...scope,
    batch_id: batch.batch_id,
    expected_version: batch.version,
    garment_ids: Object.freeze([G1, G2]),
    checks: Object.freeze([
      Object.freeze({ garment_id: G1, outcome: "pass" as const, reason_code: null }),
      Object.freeze({ garment_id: G2, outcome: "pass" as const, reason_code: null }),
    ]),
  });
  assert.ok(quality);
  batch = quality;
  const dispatched = await target.recordFactoryCheckpoint({
    ...scope,
    batch_id: batch.batch_id,
    checkpoint: "factory_dispatch",
    expected_version: batch.version,
    garment_ids: Object.freeze([G1, G2]),
    scanned_barcodes: Object.freeze(["BC-001", "BC-002"]),
  });
  assert.ok(dispatched);
  batch = dispatched;
  const attempt = await target.recordFactoryCheckpoint({
    ...scope,
    batch_id: batch.batch_id,
    checkpoint: "store_receive",
    expected_version: batch.version,
    garment_ids: Object.freeze([G1, G2]),
    scanned_barcodes: Object.freeze(["BC-001"]),
  });
  assert.equal(attempt?.outcome, "discrepancy");
  const terminal = await target.resolveFactoryDiscrepancy({
    ...scope,
    batch_id: batch.batch_id,
    attempt_id: attempt!.attempt_id,
    expected_version: batch.version,
    garment_ids: Object.freeze([G2]),
    reason_code: "exception_accepted",
  });
  assert.equal(terminal?.status, "store_received");
  const terminalVersion = terminal!.version;
  const lost = await target.transition({
    org_id: ORG,
    store_id: STORE,
    garment_ids: Object.freeze([G2]),
    target_status: "lost",
    staff_id: STAFF,
    device_id: DEVICE,
    at: AT + 20,
    reason: "confirmed missing",
    confirmation_operation: "mark_lost",
  });
  assert.equal(lost?.length, 1);
  const detail = await target.getFactoryBatch(ORG, STORE, batch.batch_id);
  assert.equal(detail?.batch.version, terminalVersion);
  assert.equal(detail?.manifest.find((item) => item.garment_id === G2)?.member_state, "exception");
  assert.equal(detail?.manifest.find((item) => item.garment_id === G2)?.status, "lost");
});

test("memory handoff covers exact custody checkpoints, repeatable QC, and terminal release", async () => {
  const target = store();
  let batch = await createBatch(target);
  const exact = async (
    checkpoint: "store_dispatch" | "factory_receive" | "factory_dispatch" | "store_receive",
  ) => {
    const result = await target.recordFactoryCheckpoint({
      ...scope,
      at: AT + batch.version,
      batch_id: batch.batch_id,
      checkpoint,
      expected_version: batch.version,
      garment_ids: Object.freeze([G1, G2]),
      scanned_barcodes: Object.freeze(["BC-001", "BC-002"]),
    });
    assert.equal(result?.outcome, "matched");
    assert.ok(result);
    batch = result;
  };
  await exact("store_dispatch");
  await exact("factory_receive");
  const rework = await target.recordFactoryQuality({
    ...scope,
    batch_id: batch.batch_id,
    expected_version: batch.version,
    garment_ids: Object.freeze([G1, G2]),
    checks: Object.freeze([
      Object.freeze({ garment_id: G1, outcome: "pass" as const, reason_code: null }),
      Object.freeze({
        garment_id: G2,
        outcome: "rework" as const,
        reason_code: "stain_remaining" as const,
      }),
    ]),
  });
  assert.deepEqual(rework && [rework.pass_count, rework.rework_count], [1, 1]);
  assert.ok(rework);
  batch = rework;
  const pass = await target.recordFactoryQuality({
    ...scope,
    at: AT + 10,
    batch_id: batch.batch_id,
    expected_version: batch.version,
    garment_ids: Object.freeze([G2]),
    checks: Object.freeze([
      Object.freeze({ garment_id: G2, outcome: "pass" as const, reason_code: null }),
    ]),
  });
  assert.equal(pass?.pass_count, 1);
  assert.ok(pass);
  batch = pass;
  await exact("factory_dispatch");
  await exact("store_receive");
  const detail = await target.getFactoryBatch(ORG, STORE, batch.batch_id);
  assert.equal(detail?.batch.status, "store_received");
  assert.equal(
    detail?.manifest.every((item) => item.member_state === "completed"),
    true,
  );
  assert.equal(
    detail?.manifest.every((item) => item.custody_state === "store"),
    true,
  );
  assert.equal(detail?.quality_checks.length, 3);
});

test("memory creation rejects missing device, closed orders, purged rows, and occupied custody", async () => {
  for (const [name, overrides] of [
    ["closed", { order_status: "closed" as const }],
    ["purged", { customer_pii_purged_at: AT }],
    ["occupied", { custody_state: "factory" as const }],
  ] as const) {
    const target = store([row(G1, `BC-${name}`, overrides)]);
    const result = await target.createFactoryBatch({
      ...scope,
      factory_code: "FACTORY_A",
      garment_ids: Object.freeze([G1]),
    });
    assert.equal(result, null, name);
  }
  const noDevice = await store([row(G1, "BC-001")]).createFactoryBatch({
    ...scope,
    device_id: null,
    factory_code: "FACTORY_A",
    garment_ids: Object.freeze([G1]),
  });
  assert.equal(noDevice, null);
});

test("memory factory rows stay scoped to their authenticated org and store", async () => {
  const target = store();
  const otherOrg = "99999999-9999-4999-8999-999999999999";
  const otherStore = "aaaaaaaa-1111-4111-8111-111111111111";
  const foreignList = await target.listFactoryBatches(otherOrg, otherStore, { limit: 20 });
  assert.deepEqual(foreignList, { batches: [], eligible_garments: [] });
  assert.equal(
    await target.createFactoryBatch({
      ...scope,
      org_id: otherOrg,
      store_id: otherStore,
      factory_code: "FACTORY_A",
      garment_ids: Object.freeze([G1, G2]),
    }),
    null,
  );
  const created = await createBatch(target);
  assert.equal(await target.getFactoryBatch(otherOrg, otherStore, created.batch_id), null);
});
