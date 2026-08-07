import assert from "node:assert/strict";
import test from "node:test";

import type { StepUpProof } from "./step-up.js";
import { MemoryStepUpProofStore } from "./step-up-proof-store.js";

const PROOF: StepUpProof = Object.freeze({
  proofId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  status: "active",
  pendingActionRef: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  argsHash: "a".repeat(64),
  entityVersions: Object.freeze([]),
  idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  requesterStaffId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  approverStaffId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  orgId: "11111111-1111-4111-8111-111111111111",
  storeId: "22222222-2222-4222-8222-222222222222",
  sessionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  sessionVersion: 1,
  issuedAt: 1_700_000_000,
  expiresAt: 1_700_000_300,
});

test("memory step-up proof CAS has exactly one winner", () => {
  const store = new MemoryStepUpProofStore();
  store.insert(PROOF);
  assert.equal(store.findActiveByPendingRef(PROOF.pendingActionRef)?.proofId, PROOF.proofId);
  assert.equal(store.atomicConsume(PROOF.proofId, PROOF.issuedAt + 1), true);
  assert.equal(store.atomicConsume(PROOF.proofId, PROOF.issuedAt + 2), false);
  assert.equal(store.get(PROOF.proofId)?.status, "consumed");
});

test("memory step-up proof expiry rejects without changing durable state", () => {
  const store = new MemoryStepUpProofStore();
  store.insert(PROOF);
  assert.equal(store.atomicConsume(PROOF.proofId, PROOF.expiresAt), false);
  assert.equal(store.get(PROOF.proofId)?.status, "active");
});
