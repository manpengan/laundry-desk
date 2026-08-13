import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { createPendingActionSnapshot } from "../pending-actions/store.js";
import { MemoryApprovalStore } from "./memory-store.js";
import { ApprovalStoreError } from "./types.js";

const ORG = randomUUID();
const STORE = randomUUID();
const REQUESTER = randomUUID();
const APPROVER = randomUUID();
const NOW = 1_900_000_000;

function tenant(staffId: string): TenantContext {
  return Object.freeze({ orgId: ORG, storeId: STORE, staffId });
}

function transaction(staffId: string) {
  return Object.freeze({ tenant: tenant(staffId), client: new FakeSqlClient() });
}

function pending(risk: "R4" | "R5" = "R4") {
  return createPendingActionSnapshot({
    nonce: randomUUID(),
    command: "payment.refund",
    commandVersion: "1.0.0",
    args: Object.freeze({ payment_id: randomUUID(), amount_cents: 100 }),
    entityVersions: Object.freeze([
      Object.freeze({ entityType: "payment", entityId: randomUUID(), version: 3 }),
    ]),
    creatorStaffId: REQUESTER,
    orgId: ORG,
    storeId: STORE,
    idempotencyKey: randomUUID(),
    createdAt: NOW,
    ttlSeconds: 300,
    effectiveRisk: risk,
    policyOutcome: "step_up",
    requiresOtherApprover: true,
  });
}

test("approval center freezes R4 authority and consumes it exactly once", async () => {
  const store = new MemoryApprovalStore();
  const action = pending();
  const created = await store.create(randomUUID(), action, 7, transaction(REQUESTER));
  assert.equal(created.argsHash, action.argsHash);
  assert.deepEqual(created.entityVersions, action.entityVersions);
  assert.equal(created.idempotencyKey, action.idempotencyKey);

  const approved = await store.decide(
    created.approvalRef,
    1,
    "approved",
    null,
    9,
    NOW + 1,
    transaction(APPROVER),
  );
  assert.equal(approved.status, "approved");
  assert.equal(approved.decidedByStaffId, APPROVER);

  const consumed = await store.consume(
    created.approvalRef,
    action,
    NOW + 2,
    transaction(REQUESTER),
  );
  assert.equal(consumed.approverStaffId, APPROVER);
  assert.equal(consumed.approval.status, "consumed");
  await assert.rejects(
    store.consume(created.approvalRef, action, NOW + 3, transaction(REQUESTER)),
    (error: unknown) => error instanceof ApprovalStoreError && error.code === "AUTHORITY_CHANGED",
  );
});

test("approval center rejects self approval, stale versions and every R5 card", async () => {
  const store = new MemoryApprovalStore();
  const action = pending();
  const created = await store.create(randomUUID(), action, 1, transaction(REQUESTER));
  await assert.rejects(
    store.decide(created.approvalRef, 1, "approved", null, 1, NOW + 1, transaction(REQUESTER)),
    (error: unknown) =>
      error instanceof ApprovalStoreError && error.code === "SELF_APPROVE_FORBIDDEN",
  );
  await assert.rejects(
    store.decide(created.approvalRef, 2, "approved", null, 1, NOW + 1, transaction(APPROVER)),
    (error: unknown) => error instanceof ApprovalStoreError && error.code === "VERSION_CONFLICT",
  );
  await assert.rejects(
    store.create(randomUUID(), pending("R5"), 1, transaction(REQUESTER)),
    (error: unknown) => error instanceof ApprovalStoreError && error.code === "INVALID_PENDING",
  );
});

test("denial requires the other actor and becomes immutable history", async () => {
  const store = new MemoryApprovalStore();
  const created = await store.create(randomUUID(), pending(), 1, transaction(REQUESTER));
  const denied = await store.decide(
    created.approvalRef,
    created.rowVersion,
    "denied",
    "金额与工单不一致",
    1,
    NOW + 1,
    transaction(APPROVER),
  );
  assert.equal(denied.status, "denied");
  assert.equal(denied.decisionReason, "金额与工单不一致");
  await assert.rejects(
    store.decide(
      created.approvalRef,
      denied.rowVersion,
      "approved",
      null,
      1,
      NOW + 2,
      transaction(APPROVER),
    ),
    (error: unknown) => error instanceof ApprovalStoreError && error.code === "ALREADY_DECIDED",
  );
});
