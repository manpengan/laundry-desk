import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import { groupPickupReminders, renderPickupReminder } from "@laundry/domain";

import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createMemoryOrderStore } from "../order/memory-store.js";
import type { GarmentRecord, OrderRecord } from "../order/types.js";
import { createMemoryNotificationDeliveryStore } from "./memory-delivery-store.js";
import { MEMORY_NOTIFICATION_TEMPLATE } from "./memory-delivery-support.js";
import { createMemoryNotificationStore } from "./memory-store.js";

const ORG_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STORE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAFF_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CUSTOMER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NOW = new Date("2026-08-12T02:00:00.000Z");
const TENANT: TenantContext = Object.freeze({
  orgId: ORG_ID,
  storeId: STORE_ID,
  staffId: STAFF_ID,
});

function order(orderId: string, ticket: string, phone: string): OrderRecord {
  return Object.freeze({
    order_id: orderId,
    org_id: ORG_ID,
    store_id: STORE_ID,
    ticket_no: ticket,
    pickup_code: "12345678",
    status: "open",
    customer_id: CUSTOMER_ID,
    customer_phone: phone,
    customer_name: "memory notification",
    note: null,
    lines: Object.freeze([
      Object.freeze({
        line_index: 0,
        service_code: "wash",
        category_code: "coat",
        unit_price_cents: 500,
        qty: 1,
        line_total_cents: 500,
        color: null,
        brand: null,
      }),
    ]),
    subtotal_cents: 500,
    original_cents: 500,
    discount_cents: 0,
    addon_cents: 0,
    urgent_cents: 0,
    freight_cents: 0,
    payable_cents: 500,
    paid_cents: 0,
    balance_cents: 500,
    created_at: Math.floor(new Date("2025-01-01T00:00:00.000Z").getTime() / 1_000),
    updated_at: Math.floor(new Date("2025-01-01T00:00:00.000Z").getTime() / 1_000),
    business_date: "2025-01-01",
    created_by_staff_id: STAFF_ID,
  });
}

function garment(orderId: string): GarmentRecord {
  return Object.freeze({
    garment_id: randomUUID(),
    order_id: orderId,
    org_id: ORG_ID,
    store_id: STORE_ID,
    line_index: 0,
    seq: 1,
    barcode: `MEM-${orderId}`,
    service_code: "wash",
    category_code: "coat",
    unit_price_cents: 500,
    color: null,
    brand: null,
    status: "racked",
  });
}

async function fixture() {
  const orderStore = createMemoryOrderStore();
  const reminderStore = createMemoryNotificationStore({ orderStore });
  const deliveryStore = createMemoryNotificationDeliveryStore({
    orderStore,
    reminderStore,
    hmacKey: Buffer.alloc(32, 7),
  });
  return { deliveryStore, orderStore, reminderStore };
}

async function enqueue(
  context: Awaited<ReturnType<typeof fixture>>,
  orderId: string,
  ticket: string,
  phone: string,
  insertOrder = true,
) {
  if (insertOrder) {
    await context.orderStore.insertOrder(order(orderId, ticket, phone), [garment(orderId)]);
  }
  const candidates = await context.reminderStore.listPickupReminders({
    client: new FakeSqlClient(),
    tenant: TENANT,
    filters: Object.freeze({
      minAgeDays: 180,
      unpaidOnly: true,
      garmentStatuses: Object.freeze(["racked" as const]),
      limit: 1,
    }),
    orderIds: [orderId],
    now: NOW,
  });
  const candidate = candidates[0];
  assert.ok(candidate?.customer_id);
  const group = groupPickupReminders([candidate], "order")[0];
  assert.ok(group);
  const message = renderPickupReminder(MEMORY_NOTIFICATION_TEMPLATE.body, group);
  const batchId = randomUUID();
  await context.deliveryStore.enqueueBatch({
    client: new FakeSqlClient(),
    tenant: TENANT,
    batchId,
    input: Object.freeze({
      order_ids: [orderId],
      channel: "sms",
      template_code: "pickup_reminder_v1",
      max_cost_cents: 0,
      min_age_days: 180,
      unpaid_only: true,
      garment_statuses: ["racked" as const],
    }),
    template: MEMORY_NOTIFICATION_TEMPLATE,
    providerCode: "software_only_fake",
    assurance: "software_only",
    estimatedCostCents: 0,
    createdByStaffId: STAFF_ID,
    createdAt: NOW,
    deliveries: [
      Object.freeze({
        id: randomUUID(),
        candidate: Object.freeze({ ...candidate, customer_id: candidate.customer_id }),
        messageSha256: createHash("sha256").update(message, "utf8").digest("hex"),
      }),
    ],
  });
  return batchId;
}

test("memory outbox coordinates early receipts and rejects the wrong provider", async () => {
  const context = await fixture();
  const batchId = await enqueue(context, randomUUID(), "MEM-0001", "13800000000");
  const claims = await Promise.all([
    context.deliveryStore.claimNext(TENANT, "worker-a", NOW),
    context.deliveryStore.claimNext(TENANT, "worker-b", NOW),
  ]);
  const claim = claims.find((candidate) => candidate !== null);
  assert.ok(claim);
  assert.equal(claims.filter((candidate) => candidate !== null).length, 1);
  assert.equal(claim.attemptNo, 1);

  const acceptedAt = new Date(NOW.getTime() + 1_000);
  const receipt = Object.freeze({
    deliveryId: claim.deliveryId,
    providerCode: "software_only_fake",
    receiptId: "receipt-1",
    status: "delivered" as const,
    observedAt: new Date(NOW.getTime() + 500),
    recordedAt: new Date(NOW.getTime() + 600),
  });
  assert.equal(
    await context.deliveryStore.applyReceipt(TENANT, {
      ...receipt,
      providerCode: "wrong_provider",
      receiptId: "wrong-provider-receipt",
    }),
    "ignored",
  );
  assert.equal(await context.deliveryStore.applyReceipt(TENANT, receipt), "pending");
  assert.equal(
    await context.deliveryStore.settleAttempt(TENANT, {
      deliveryId: claim.deliveryId,
      leaseToken: claim.leaseToken,
      attemptNo: claim.attemptNo,
      outcome: "accepted",
      errorCode: null,
      providerRefSha256: "a".repeat(64),
      costCents: 0,
      startedAt: NOW,
      completedAt: acceptedAt,
    }),
    "accepted",
  );
  const detail = await context.deliveryStore.getBatch(new FakeSqlClient(), TENANT, batchId);
  assert.equal(detail?.batch.status, "completed");
  assert.equal(detail?.deliveries[0]?.status, "delivered");
  assert.equal(await context.deliveryStore.applyReceipt(TENANT, receipt), "duplicate");
  const completed = await context.deliveryStore.getBatch(new FakeSqlClient(), TENANT, batchId);
  assert.equal(completed?.batch.status, "completed");
  assert.equal(completed?.deliveries[0]?.status, "delivered");
  assert.equal(
    await context.deliveryStore.applyReceipt(TENANT, {
      ...receipt,
      receiptId: "late-failure",
      status: "failed",
    }),
    "ignored",
  );
  assert.equal(
    (await context.deliveryStore.getBatch(new FakeSqlClient(), TENANT, batchId))?.deliveries[0]
      ?.status,
    "delivered",
  );
});

test("memory outbox rejects a second automatic delivery for the same order", async () => {
  const context = await fixture();
  const orderId = randomUUID();
  await enqueue(context, orderId, "MEM-DUPLICATE", "13500000000");
  assert.equal(
    await context.deliveryStore.assertOrdersAvailable(new FakeSqlClient(), TENANT, [orderId]),
    false,
  );
  await assert.rejects(
    () => enqueue(context, orderId, "MEM-DUPLICATE", "13500000000", false),
    /NOTIFICATION_DELIVERY_ACTIVE/u,
  );
});

test("memory outbox records an abandoned lease before claiming the next attempt", async () => {
  const context = await fixture();
  await enqueue(context, randomUUID(), "MEM-LEASE", "13400000000");
  const first = await context.deliveryStore.claimNext(TENANT, "worker-1", NOW);
  assert.equal(first?.attemptNo, 1);
  const second = await context.deliveryStore.claimNext(
    TENANT,
    "worker-2",
    new Date(NOW.getTime() + 30_000),
  );
  assert.equal(second?.deliveryId, first?.deliveryId);
  assert.equal(second?.attemptNo, 2);
});

test("memory outbox uses fixed retry backoff and never reclaims a live lease", async () => {
  const context = await fixture();
  await enqueue(context, randomUUID(), "MEM-0002", "13900000000");
  const first = await context.deliveryStore.claimNext(TENANT, "worker-a", NOW);
  assert.ok(first);
  assert.equal(
    await context.deliveryStore.claimNext(TENANT, "worker-b", new Date(NOW.getTime() + 29_999)),
    null,
  );
  const completedAt = new Date(NOW.getTime() + 2_000);
  assert.equal(
    await context.deliveryStore.settleAttempt(TENANT, {
      deliveryId: first.deliveryId,
      leaseToken: first.leaseToken,
      attemptNo: 1,
      outcome: "transient_failure",
      errorCode: "PROVIDER_BUSY",
      providerRefSha256: null,
      costCents: 0,
      startedAt: NOW,
      completedAt,
    }),
    "retry_wait",
  );
  assert.equal(
    await context.deliveryStore.claimNext(
      TENANT,
      "worker-b",
      new Date(completedAt.getTime() + 59_999),
    ),
    null,
  );
  const second = await context.deliveryStore.claimNext(
    TENANT,
    "worker-b",
    new Date(completedAt.getTime() + 60_000),
  );
  assert.equal(second?.deliveryId, first.deliveryId);
  assert.equal(second?.attemptNo, 2);
});

test("memory outbox moves an abandoned fifth claim to manual fallback", async () => {
  const context = await fixture();
  const batchId = await enqueue(context, randomUUID(), "MEM-0005", "13600000000");
  const retryDelays = [60_000, 300_000, 1_800_000, 7_200_000] as const;
  let claimAt = NOW;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const claim = await context.deliveryStore.claimNext(TENANT, `worker-${attempt}`, claimAt);
    assert.equal(claim?.attemptNo, attempt);
    assert.ok(claim);
    const completedAt = new Date(claimAt.getTime() + 1_000);
    assert.equal(
      await context.deliveryStore.settleAttempt(TENANT, {
        deliveryId: claim.deliveryId,
        leaseToken: claim.leaseToken,
        attemptNo: claim.attemptNo,
        outcome: "transient_failure",
        errorCode: "PROVIDER_BUSY",
        providerRefSha256: null,
        costCents: 0,
        startedAt: claimAt,
        completedAt,
      }),
      "retry_wait",
    );
    claimAt = new Date(completedAt.getTime() + retryDelays[attempt - 1]!);
  }
  const fifth = await context.deliveryStore.claimNext(TENANT, "worker-5", claimAt);
  assert.equal(fifth?.attemptNo, 5);
  assert.equal(
    await context.deliveryStore.claimNext(
      TENANT,
      "worker-after-crash",
      new Date(claimAt.getTime() + 30_000),
    ),
    null,
  );
  const detail = await context.deliveryStore.getBatch(new FakeSqlClient(), TENANT, batchId);
  assert.equal(detail?.batch.status, "attention_required");
  assert.equal(detail?.deliveries[0]?.status, "manual_required");
  assert.equal(detail?.deliveries[0]?.attempt_count, 5);
  assert.equal(detail?.deliveries[0]?.last_error_code, "PROVIDER_RETRY_EXHAUSTED");
});

test("accepted rows time out to manual fallback without claiming delivery", async () => {
  const context = await fixture();
  const batchId = await enqueue(context, randomUUID(), "MEM-0003", "13700000000");
  const claim = await context.deliveryStore.claimNext(TENANT, "worker-a", NOW);
  assert.ok(claim);
  await context.deliveryStore.settleAttempt(TENANT, {
    deliveryId: claim.deliveryId,
    leaseToken: claim.leaseToken,
    attemptNo: 1,
    outcome: "accepted",
    errorCode: null,
    providerRefSha256: "b".repeat(64),
    costCents: 0,
    startedAt: NOW,
    completedAt: NOW,
  });
  assert.equal(
    await context.deliveryStore.expireAccepted(
      TENANT,
      new Date(NOW.getTime() + 72 * 60 * 60 * 1_000 - 1),
      10,
    ),
    0,
  );
  assert.equal(
    await context.deliveryStore.expireAccepted(
      TENANT,
      new Date(NOW.getTime() + 72 * 60 * 60 * 1_000),
      10,
    ),
    1,
  );
  const detail = await context.deliveryStore.getBatch(new FakeSqlClient(), TENANT, batchId);
  assert.equal(detail?.batch.status, "attention_required");
  assert.equal(detail?.deliveries[0]?.last_error_code, "RECEIPT_TIMEOUT");
});
