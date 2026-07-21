import assert from "node:assert/strict";
import test from "node:test";

import { MemoryPendingActionStore } from "../pending-actions/store.js";
import { createStepUpProof, verifyStepUpProof } from "./step-up.js";

const CREATOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const APPROVER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORG = "11111111-1111-4111-8111-111111111111";
const STORE = "22222222-2222-4222-8222-222222222222";

const seedPending = (store: MemoryPendingActionStore, createdAt = 1_700_000_000) =>
  store.create({
    nonce: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    command: "order.refund",
    commandVersion: "1.0.0",
    args: { order_id: "o1", amount_cents: 500 },
    entityVersions: Object.freeze([
      { entityType: "order", entityId: "99999999-9999-4999-8999-999999999999", version: 2 },
    ]),
    creatorStaffId: CREATOR,
    orgId: ORG,
    storeId: STORE,
    idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    createdAt,
    effectiveRisk: "R4",
    policyOutcome: "step_up",
    requiresOtherApprover: true,
  });

test("createStepUpProof binds pending fields and rejects self-approve", () => {
  const store = new MemoryPendingActionStore();
  const pending = seedPending(store);
  const proof = createStepUpProof({
    proofId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    pending,
    approverStaffId: APPROVER,
    issuedAt: pending.createdAt + 1,
  });
  assert.equal(proof.pendingActionRef, pending.nonce);
  assert.equal(proof.argsHash, pending.argsHash);
  assert.equal(proof.requesterStaffId, CREATOR);
  assert.equal(proof.approverStaffId, APPROVER);

  assert.throws(
    () =>
      createStepUpProof({
        proofId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        pending,
        approverStaffId: CREATOR,
        issuedAt: pending.createdAt + 1,
      }),
    /cannot be issued to the action creator/,
  );
});

test("verifyStepUpProof accepts matching active proof", () => {
  const store = new MemoryPendingActionStore();
  const pending = seedPending(store);
  const proof = createStepUpProof({
    proofId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    pending,
    approverStaffId: APPROVER,
    issuedAt: pending.createdAt + 1,
  });
  const result = verifyStepUpProof(proof, pending, pending.createdAt + 10);
  assert.deepEqual(result, { ok: true });
});

test("verifyStepUpProof rejects expired proof and self-approve binding", () => {
  const store = new MemoryPendingActionStore();
  const pending = seedPending(store);
  const proof = createStepUpProof({
    proofId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    pending,
    approverStaffId: APPROVER,
    issuedAt: pending.createdAt + 1,
    ttlSeconds: 30,
  });
  const expired = verifyStepUpProof(proof, pending, pending.createdAt + 1 + 30);
  assert.equal(expired.ok, false);
  if (!expired.ok) assert.equal(expired.reason, "PROOF_EXPIRED");

  const bad = {
    ...proof,
    approverStaffId: CREATOR,
    requesterStaffId: CREATOR,
  };
  const self = verifyStepUpProof(bad, pending, pending.createdAt + 2);
  assert.equal(self.ok, false);
  if (!self.ok) assert.equal(self.reason, "SELF_APPROVE_FORBIDDEN");
});

test("verifyStepUpProof rejects args_hash mismatch (WYSIWYS)", () => {
  const store = new MemoryPendingActionStore();
  const pending = seedPending(store);
  const proof = createStepUpProof({
    proofId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    pending,
    approverStaffId: APPROVER,
    issuedAt: pending.createdAt + 1,
  });
  const tampered = { ...proof, argsHash: "0".repeat(64) };
  const result = verifyStepUpProof(tampered, pending, pending.createdAt + 2);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "ARGS_HASH_MISMATCH");
});
