/** Money Integrity + Workday Commands: server price, ledger, draft, cancel, close gate. */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { INSERT_AUDIT_LOG_SQL } from "../audit/write-audit.js";
import { executeCommand } from "../bus/executor.js";
import { MemoryIdempotencyStore } from "../bus/idempotency.js";
import type { ActorContext } from "../bus/types.js";
import { createMemoryCatalogStore } from "../catalog/memory-catalog.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createDefaultChainHooks } from "../handlers/default-chain-hooks.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { DEMO_ORG_ID, DEMO_STAFF_A_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import type { OrderHandlerDeps } from "../order/deps.js";
import { createMemoryOrderStore } from "../order/memory-store.js";
import type { OrderStore } from "../order/types.js";
import {
  createMemoryAuditQueryStore,
  createMemoryFeaturesStore,
  createMemorySettingsStore,
} from "../platform/index.js";
import { MemoryPendingActionStore } from "../pending-actions/store.js";
import { MemoryStepUpProofStore } from "../policy/step-up-proof-store.js";
import { createStepUpProof } from "../policy/step-up.js";

const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_STAFF_A_ID,
});

const CLERK: ActorContext = Object.freeze({
  staffId: DEMO_STAFF_A_ID,
  deviceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  via: "ui" as const,
  permissions: Object.freeze(["order_write", "staff_read", "payment_refund"]),
});
const APPROVER: ActorContext = Object.freeze({
  ...CLERK,
  staffId: "10000000-0000-4000-8000-000000000099",
});

const NOW = 1_721_606_400;
const BUSINESS_DATE = "2024-07-22";
const SESSION_BINDING = Object.freeze({
  sessionId: "20000000-0000-4000-8000-000000000001",
  sessionVersion: 1,
});

function buildBus(overrides: Partial<OrderHandlerDeps> = {}) {
  const store = overrides.store ?? createMemoryOrderStore();
  const order: OrderHandlerDeps = Object.freeze({
    store,
    catalog: createMemoryCatalogStore(),
    now: () => NOW,
    ...overrides,
  });
  const { registry } = createRegisteredM1Bus({
    platform: Object.freeze({
      settings: createMemorySettingsStore(),
      features: createMemoryFeaturesStore(),
      audit: createMemoryAuditQueryStore(),
    }),
    order,
  });
  const pendingStore = new MemoryPendingActionStore();
  const idempotencyStore = new MemoryIdempotencyStore();
  return Object.freeze({
    registry,
    store,
    pendingStore,
    idempotencyStore,
    chainHooks: createDefaultChainHooks({}, pendingStore),
  });
}

async function command(
  bus: ReturnType<typeof buildBus>,
  name: string,
  input: Readonly<Record<string, unknown>>,
) {
  return executeCommand(new FakeSqlClient(), TENANT, name, input, {
    registry: bus.registry,
    actor: CLERK,
    chainHooks: bus.chainHooks,
    pendingStore: bus.pendingStore,
  });
}

async function confirmedCommand(
  bus: ReturnType<typeof buildBus>,
  name: string,
  input: Readonly<Record<string, unknown>>,
) {
  const first = await command(bus, name, input);
  assert.equal(first.ok, false, JSON.stringify(first));
  if (first.ok) return first;
  assert.equal(first.error.code, "POLICY_CONFIRMATION_REQUIRED", JSON.stringify(first));
  const detail = "detail" in first.error ? first.error.detail : undefined;
  assert.equal(detail?.kind, "confirmation");
  if (detail?.kind !== "confirmation") assert.fail("missing confirmation reference");
  return executeCommand(
    new FakeSqlClient(),
    TENANT,
    name,
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

type RefundChallenge = Readonly<{
  confirmRef: string;
  input: Readonly<Record<string, unknown>>;
}>;

async function createRefundChallenge(bus: ReturnType<typeof buildBus>): Promise<RefundChallenge> {
  const received = await command(bus, "order.receive", {
    lines: [{ service_code: "wash", category_code: "shirt", qty: 1 }],
    initial_payment: { amount_cents: 1000, method: "cash" },
  });
  assert.equal(received.ok, true, JSON.stringify(received));
  if (!received.ok) assert.fail("expected paid order");
  const orderId = (received.data.result as { order_id: string }).order_id;
  const original = (await bus.store.listPayments?.(TENANT.orgId, TENANT.storeId, orderId))?.[0];
  assert.ok(original);
  const input = Object.freeze({
    order_id: orderId,
    amount_cents: 100,
    method: original.method,
    ref_payment_id: original.payment_id,
    reason: "audited refund approval",
  });
  const first = await executeCommand(new FakeSqlClient(), TENANT, "payment.refund", input, {
    registry: bus.registry,
    actor: CLERK,
    chainHooks: bus.chainHooks,
    pendingStore: bus.pendingStore,
  });
  assert.equal(first.ok, false, JSON.stringify(first));
  if (first.ok) assert.fail("expected refund step-up");
  const detail = "detail" in first.error ? first.error.detail : undefined;
  if (detail?.kind !== "confirmation") assert.fail("missing refund confirm_ref");
  return Object.freeze({ confirmRef: detail.confirm_ref, input });
}

function readApprovalAudit(client: FakeSqlClient): Readonly<Record<string, unknown>> {
  const query = client.queries.find((entry) => entry.sql === INSERT_AUDIT_LOG_SQL);
  assert.ok(query, "expected same-transaction audit INSERT");
  const afterJson = query.params?.[11];
  if (typeof afterJson !== "string") assert.fail("expected audit after_json");
  const parsed: unknown = JSON.parse(afterJson);
  assert.ok(parsed !== null && typeof parsed === "object" && !Array.isArray(parsed));
  return parsed as Readonly<Record<string, unknown>>;
}

async function executeRefundWithProof(
  bus: ReturnType<typeof buildBus>,
  confirmRef: string,
  options: Readonly<{ client?: FakeSqlClient; idempotencyKey?: string }> = {},
) {
  const pending = await bus.pendingStore.get(confirmRef);
  assert.ok(pending);
  const proofStore = new MemoryStepUpProofStore();
  await proofStore.insert(
    createStepUpProof({
      proofId: randomUUID(),
      pending,
      approverStaffId: APPROVER.staffId,
      issuedAt: Math.floor(Date.now() / 1000),
      sessionBinding: SESSION_BINDING,
    }),
  );
  return executeCommand(
    options.client ?? new FakeSqlClient(),
    TENANT,
    "payment.refund",
    {},
    {
      registry: bus.registry,
      actor: CLERK,
      chainHooks: bus.chainHooks,
      pendingStore: bus.pendingStore,
      stepUpProofStore: proofStore,
      stepUpApproverAuthority: async () => true,
      idempotencyStore: bus.idempotencyStore,
      confirmRef,
      sessionBinding: SESSION_BINDING,
      ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
    },
  );
}

test("receive snapshots the catalog price and appends the selected initial payment", async () => {
  const bus = buildBus();
  const received = await command(bus, "order.receive", {
    lines: [
      {
        service_code: "wash",
        category_code: "shirt",
        unit_price_cents: 1,
        qty: 1,
      },
    ],
    initial_payment: { amount_cents: 500, method: "wechat" },
  });
  assert.equal(received.ok, true, JSON.stringify(received));
  if (!received.ok) return;
  const body = received.data.result as {
    order_id: string;
    payable_cents: number;
    paid_cents: number;
    balance_cents: number;
  };
  assert.equal(body.payable_cents, 1500);
  assert.equal(body.paid_cents, 500);
  assert.equal(body.balance_cents, 1000);
  const payments = await bus.store.listPayments?.(TENANT.orgId, TENANT.storeId, body.order_id);
  assert.equal(payments?.length, 1);
  assert.equal(payments?.[0]?.method, "wechat");
  assert.equal(payments?.[0]?.business_date, BUSINESS_DATE);
});

test("collect then repay append distinct ledger rows and settle the balance", async () => {
  const bus = buildBus();
  const received = await command(bus, "order.receive", {
    lines: [{ service_code: "wash", category_code: "shirt", qty: 1 }],
  });
  assert.equal(received.ok, true, JSON.stringify(received));
  if (!received.ok) return;
  const orderId = (received.data.result as { order_id: string }).order_id;

  const collected = await command(bus, "payment.collect", {
    order_id: orderId,
    amount_cents: 500,
    method: "cash",
  });
  assert.equal(collected.ok, true, JSON.stringify(collected));
  const repaid = await command(bus, "payment.repay", {
    order_id: orderId,
    amount_cents: 1000,
    method: "alipay",
  });
  assert.equal(repaid.ok, true, JSON.stringify(repaid));
  if (!repaid.ok) return;
  assert.equal((repaid.data.result as { balance_cents: number }).balance_cents, 0);

  const payments = await bus.store.listPayments?.(TENANT.orgId, TENANT.storeId, orderId);
  assert.deepEqual(
    payments?.map((payment) => [payment.kind, payment.amount_cents, payment.method]),
    [
      ["pay", 500, "cash"],
      ["repay", 1000, "alipay"],
    ],
  );
});

test("refund appends a referenced ledger row and idempotent replay cannot double-refund", async () => {
  const bus = buildBus();
  const received = await command(bus, "order.receive", {
    lines: [{ service_code: "wash", category_code: "shirt", qty: 1 }],
    initial_payment: { amount_cents: 1000, method: "cash" },
  });
  assert.equal(received.ok, true, JSON.stringify(received));
  if (!received.ok) return;
  const orderId = (received.data.result as { order_id: string }).order_id;
  const original = (await bus.store.listPayments?.(TENANT.orgId, TENANT.storeId, orderId))?.[0];
  assert.ok(original);

  const input = Object.freeze({
    order_id: orderId,
    amount_cents: 400,
    method: original.method,
    ref_payment_id: original.payment_id,
    reason: "customer changed service",
  });
  const idempotencyKey = "10000000-0000-4000-8000-000000000088";
  const first = await executeCommand(new FakeSqlClient(), TENANT, "payment.refund", input, {
    registry: bus.registry,
    actor: CLERK,
    chainHooks: bus.chainHooks,
    pendingStore: bus.pendingStore,
    idempotencyStore: bus.idempotencyStore,
    idempotencyKey,
  });
  assert.equal(first.ok, false, JSON.stringify(first));
  if (first.ok) return;
  assert.equal(first.error.code, "POLICY_STEP_UP_REQUIRED");
  const detail = "detail" in first.error ? first.error.detail : undefined;
  assert.equal(detail?.kind, "confirmation");
  if (detail?.kind !== "confirmation") assert.fail("missing step-up confirmation reference");

  const executed = await executeRefundWithProof(bus, detail.confirm_ref, { idempotencyKey });
  assert.equal(executed.ok, true, JSON.stringify(executed));
  if (!executed.ok) return;
  assert.deepEqual(executed.data.result, {
    order_id: orderId,
    payment_id: (executed.data.result as { payment_id: string }).payment_id,
    kind: "refund",
    ref_payment_id: original.payment_id,
    paid_cents: 600,
    balance_cents: 900,
    status: "open",
  });

  const replayed = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "payment.refund",
    {},
    {
      registry: bus.registry,
      actor: CLERK,
      chainHooks: bus.chainHooks,
      pendingStore: bus.pendingStore,
      idempotencyStore: bus.idempotencyStore,
      confirmRef: detail.confirm_ref,
    },
  );
  assert.deepEqual(replayed, executed);

  const conflictingFirstHop = await executeCommand(
    new FakeSqlClient(),
    TENANT,
    "payment.refund",
    input,
    {
      registry: bus.registry,
      actor: CLERK,
      chainHooks: bus.chainHooks,
      pendingStore: bus.pendingStore,
      idempotencyStore: bus.idempotencyStore,
      idempotencyKey,
    },
  );
  assert.equal(conflictingFirstHop.ok, false);
  if (!conflictingFirstHop.ok) {
    assert.equal(conflictingFirstHop.error.code, "IDEMPOTENCY_CONFLICT");
  }
  const payments = await bus.store.listPayments?.(TENANT.orgId, TENANT.storeId, orderId);
  assert.equal(payments?.length, 2);
  assert.equal(payments?.[1]?.kind, "refund");
  assert.equal(payments?.[1]?.ref_payment_id, original.payment_id);
  assert.equal(payments?.[1]?.method, original.method);
  assert.equal(payments?.[1]?.note, input.reason);
});

test("refund confirm_ref cannot be resumed directly by another administrator", async () => {
  const bus = buildBus();
  const challenge = await createRefundChallenge(bus);
  const client = new FakeSqlClient();
  const result = await executeCommand(
    client,
    Object.freeze({ ...TENANT, staffId: APPROVER.staffId }),
    "payment.refund",
    {},
    {
      registry: bus.registry,
      actor: APPROVER,
      chainHooks: bus.chainHooks,
      pendingStore: bus.pendingStore,
      confirmRef: challenge.confirmRef,
    },
  );
  assert.equal(result.ok, false, JSON.stringify(result));
  if (!result.ok) assert.equal(result.error.code, "POLICY_DENIED");
  assert.equal(
    client.queries.some((entry) => entry.sql === INSERT_AUDIT_LOG_SQL),
    false,
  );
});

test("refund audit persists PIN approver when initiator resumes with proof", async () => {
  const bus = buildBus();
  const challenge = await createRefundChallenge(bus);
  const pending = bus.pendingStore.get(challenge.confirmRef);
  assert.ok(pending);
  const proofStore = new MemoryStepUpProofStore();
  const issuedAt = Math.floor(Date.now() / 1000);
  proofStore.insert(
    createStepUpProof({
      proofId: "20000000-0000-4000-8000-000000000002",
      pending,
      approverStaffId: APPROVER.staffId,
      issuedAt,
      sessionBinding: SESSION_BINDING,
    }),
  );
  const client = new FakeSqlClient();
  const result = await executeCommand(
    client,
    TENANT,
    "payment.refund",
    {},
    {
      registry: bus.registry,
      actor: CLERK,
      chainHooks: bus.chainHooks,
      pendingStore: bus.pendingStore,
      stepUpProofStore: proofStore,
      stepUpApproverAuthority: async () => true,
      confirmRef: challenge.confirmRef,
      sessionBinding: SESSION_BINDING,
    },
  );
  assert.equal(result.ok, true, JSON.stringify(result));

  bus.pendingStore.clear();
  proofStore.clear();
  const audit = readApprovalAudit(client);
  assert.equal(audit.initiated_by_staff_id, CLERK.staffId);
  assert.equal(audit.approved_by_staff_id, APPROVER.staffId);
  assert.doesNotMatch(JSON.stringify(audit), /pin|proof|session/iu);
});

test("refund rejects a client method that differs from the referenced immutable payment", async () => {
  const bus = buildBus();
  const received = await command(bus, "order.receive", {
    lines: [{ service_code: "wash", category_code: "shirt", qty: 1 }],
    initial_payment: { amount_cents: 1000, method: "cash" },
  });
  assert.equal(received.ok, true, JSON.stringify(received));
  if (!received.ok) return;
  const orderId = (received.data.result as { order_id: string }).order_id;
  const original = (await bus.store.listPayments?.(TENANT.orgId, TENANT.storeId, orderId))?.[0];
  assert.ok(original);

  const input = Object.freeze({
    order_id: orderId,
    amount_cents: 100,
    method: "wechat",
    ref_payment_id: original.payment_id,
    reason: "method mismatch must fail closed",
  });
  const first = await executeCommand(new FakeSqlClient(), TENANT, "payment.refund", input, {
    registry: bus.registry,
    actor: CLERK,
    chainHooks: bus.chainHooks,
    pendingStore: bus.pendingStore,
  });
  assert.equal(first.ok, false, JSON.stringify(first));
  if (first.ok) return;
  assert.equal(first.error.code, "POLICY_STEP_UP_REQUIRED");
  const detail = "detail" in first.error ? first.error.detail : undefined;
  assert.equal(detail?.kind, "confirmation");
  if (detail?.kind !== "confirmation") assert.fail("missing step-up confirmation reference");

  const executed = await executeRefundWithProof(bus, detail.confirm_ref);
  assert.equal(executed.ok, false, JSON.stringify(executed));
  if (!executed.ok) assert.equal(executed.error.code, "VALIDATION_FAILED");
  const payments = await bus.store.listPayments?.(TENANT.orgId, TENANT.storeId, orderId);
  assert.equal(payments?.length, 1);
});

test("hold creates a ticketless draft and receive resets its formal created_at", async () => {
  let clock = NOW - 31 * 86_400;
  const bus = buildBus({ now: () => clock });
  const held = await command(bus, "order.hold", {
    customer_phone: "13800000111",
    lines: [{ service_code: "dry", category_code: "coat", qty: 1 }],
  });
  assert.equal(held.ok, true, JSON.stringify(held));
  if (!held.ok) return;
  const draftId = (held.data.result as { draft_id: string }).draft_id;
  const draft = await bus.store.getOrder(TENANT.orgId, TENANT.storeId, draftId);
  assert.equal(draft?.status, "draft");
  assert.equal(draft?.ticket_no, null);
  assert.equal(draft?.created_at, clock);
  assert.equal((await bus.store.listGarments(TENANT.orgId, TENANT.storeId, draftId)).length, 0);

  clock = NOW;
  const received = await command(bus, "order.receive", {
    draft_id: draftId,
    customer_phone: "13800000111",
    lines: [{ service_code: "dry", category_code: "coat", qty: 1 }],
    initial_payment: { amount_cents: 1000, method: "cash" },
  });
  assert.equal(received.ok, true, JSON.stringify(received));
  const opened = await bus.store.getOrder(TENANT.orgId, TENANT.storeId, draftId);
  assert.equal(opened?.status, "open");
  assert.equal(opened?.created_at, NOW, "draft age must not become open-order retention age");
  assert.match(opened?.ticket_no ?? "", /^\d{8}-\d{4}$/u);
  assert.equal((await bus.store.listGarments(TENANT.orgId, TENANT.storeId, draftId)).length, 1);
});

test("receive cannot turn an unknown client-selected draft id into a new order", async () => {
  const bus = buildBus();
  const chosenId = randomUUID();
  const received = await command(bus, "order.receive", {
    draft_id: chosenId,
    lines: [{ service_code: "dry", category_code: "coat", qty: 1 }],
  });
  assert.equal(received.ok, false, JSON.stringify(received));
  if (!received.ok) assert.equal(received.error.code, "VALIDATION_FAILED");
  assert.equal(await bus.store.getOrder(TENANT.orgId, TENANT.storeId, chosenId), null);
});

test("hold cannot create a new draft under a client-selected replacement id", async () => {
  const bus = buildBus();
  const chosenId = randomUUID();
  const held = await command(bus, "order.hold", {
    draft_id: chosenId,
    lines: [{ service_code: "dry", category_code: "coat", qty: 1 }],
  });
  assert.equal(held.ok, false, JSON.stringify(held));
  if (!held.ok) assert.equal(held.error.code, "VALIDATION_FAILED");
  assert.equal(await bus.store.getOrder(TENANT.orgId, TENANT.storeId, chosenId), null);
});

test("cancel records append-only reversals instead of deleting the original payment", async () => {
  const bus = buildBus();
  const received = await command(bus, "order.receive", {
    lines: [{ service_code: "wash", category_code: "shirt", qty: 1 }],
    initial_payment: { amount_cents: 1500, method: "cash" },
  });
  assert.equal(received.ok, true, JSON.stringify(received));
  if (!received.ok) return;
  const orderId = (received.data.result as { order_id: string }).order_id;

  const cancelled = await confirmedCommand(bus, "order.cancel", {
    order_id: orderId,
    reason: "customer changed mind",
  });
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  const order = await bus.store.getOrder(TENANT.orgId, TENANT.storeId, orderId);
  assert.equal(order?.status, "cancelled");
  const payments = await bus.store.listPayments?.(TENANT.orgId, TENANT.storeId, orderId);
  assert.equal(payments?.length, 2);
  assert.equal(payments?.[0]?.kind, "pay");
  assert.equal(payments?.[1]?.kind, "reversal");
  assert.equal(payments?.[1]?.ref_payment_id, payments?.[0]?.payment_id);
});

test("cancel callback failure leaves the memory order and payment ledger unchanged", async () => {
  let cancellationAttempts = 0;
  const bus = buildBus({
    couponCancellation: async () => {
      cancellationAttempts += 1;
      throw new Error("forced coupon reversal failure");
    },
  });
  const received = await command(bus, "order.receive", {
    lines: [{ service_code: "wash", category_code: "shirt", qty: 1 }],
    initial_payment: { amount_cents: 1_500, method: "cash" },
  });
  assert.equal(received.ok, true, JSON.stringify(received));
  if (!received.ok) return;
  const orderId = (received.data.result as { order_id: string }).order_id;

  const cancelled = await confirmedCommand(bus, "order.cancel", {
    order_id: orderId,
    reason: "force rollback",
  });
  assert.equal(cancelled.ok, false, JSON.stringify(cancelled));
  if (!cancelled.ok) assert.equal(cancelled.error.code, "TRANSACTION_FAILED");
  assert.equal(cancellationAttempts, 1);
  assert.equal((await bus.store.getOrder(TENANT.orgId, TENANT.storeId, orderId))?.status, "open");
  const payments = await bus.store.listPayments?.(TENANT.orgId, TENANT.storeId, orderId);
  assert.equal(payments?.length, 1);
  assert.equal(payments?.[0]?.kind, "pay");
});

test("closed business days reject new counter writes with SHIFT_CLOSED", async () => {
  const store: OrderStore = createMemoryOrderStore();
  const bus = buildBus({ store, isBusinessDayClosed: async () => true });
  const result = await command(bus, "order.receive", {
    lines: [{ service_code: "wash", category_code: "shirt", qty: 1 }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "SHIFT_CLOSED");
});

test("business writes acquire the shared day lock before rechecking closed state", async () => {
  const calls: string[] = [];
  const bus = buildBus({
    lockBusinessDay: async (_client, tenant, businessDate) => {
      assert.equal(tenant.orgId, TENANT.orgId);
      assert.equal(businessDate, BUSINESS_DATE);
      calls.push("lock");
    },
    isBusinessDayClosed: async () => {
      calls.push("check");
      return true;
    },
  });
  const result = await command(bus, "order.receive", {
    lines: [{ service_code: "wash", category_code: "shirt", qty: 1 }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "SHIFT_CLOSED");
  assert.deepEqual(calls, ["lock", "check"]);
});
