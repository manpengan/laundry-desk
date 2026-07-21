import assert from "node:assert/strict";
import test from "node:test";

import { hashCanonical } from "./canonical.js";
import { MemoryPendingActionStore } from "./store.js";
import type { CreatePendingActionInput } from "./types.js";

const CREATOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const APPROVER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORG = "11111111-1111-4111-8111-111111111111";
const STORE = "22222222-2222-4222-8222-222222222222";

const baseInput = (overrides: Partial<CreatePendingActionInput> = {}): CreatePendingActionInput =>
  Object.freeze({
    nonce: overrides.nonce ?? "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    command: overrides.command ?? "order.refund",
    commandVersion: overrides.commandVersion ?? "1.0.0",
    args: overrides.args ?? { order_id: "o1", amount_cents: 500 },
    entityVersions:
      overrides.entityVersions ??
      Object.freeze([{ entityType: "order", entityId: ORG, version: 3 }]),
    creatorStaffId: overrides.creatorStaffId ?? CREATOR,
    orgId: overrides.orgId ?? ORG,
    storeId: overrides.storeId ?? STORE,
    idempotencyKey: overrides.idempotencyKey ?? "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    createdAt: overrides.createdAt ?? 1_700_000_000,
    effectiveRisk: overrides.effectiveRisk ?? "R4",
    policyOutcome: overrides.policyOutcome ?? "step_up",
    requiresOtherApprover: overrides.requiresOtherApprover ?? true,
    ...(overrides.ttlSeconds !== undefined ? { ttlSeconds: overrides.ttlSeconds } : {}),
  });

test("create freezes args and computes args_hash", () => {
  const store = new MemoryPendingActionStore();
  const action = store.create(baseInput());
  assert.equal(action.status, "pending");
  assert.equal(action.argsHash, hashCanonical({ amount_cents: 500, order_id: "o1" }));
  assert.ok(Object.isFrozen(action));
  assert.ok(Object.isFrozen(action.args));
});

test("WYSIWYS: different args produce different hash; old card hash mismatches", () => {
  const store = new MemoryPendingActionStore();
  const card = store.create(baseInput({ args: { order_id: "o1", amount_cents: 500 } }));
  const tamperedHash = hashCanonical({ order_id: "o1", amount_cents: 999 });
  assert.notEqual(card.argsHash, tamperedHash);

  const result = store.atomicConsume(card.nonce, APPROVER, {
    nowEpochSeconds: card.createdAt + 1,
    expectedArgsHash: tamperedHash,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "ARGS_HASH_MISMATCH");
  assert.equal(store.get(card.nonce)?.status, "pending");
});

test("self-approve rejected when requiresOtherApprover", () => {
  const store = new MemoryPendingActionStore();
  const card = store.create(baseInput({ requiresOtherApprover: true }));
  const result = store.atomicConsume(card.nonce, CREATOR, {
    nowEpochSeconds: card.createdAt + 1,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "SELF_APPROVE_FORBIDDEN");
});

test("self-approve allowed when not required (R3 confirm)", () => {
  const store = new MemoryPendingActionStore();
  const card = store.create(
    baseInput({
      policyOutcome: "confirm",
      requiresOtherApprover: false,
      effectiveRisk: "R3",
    }),
  );
  const result = store.atomicConsume(card.nonce, CREATOR, {
    nowEpochSeconds: card.createdAt + 1,
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.action.status, "consumed");
    assert.equal(result.action.consumedByStaffId, CREATOR);
  }
});

test("atomic single consume: second concurrent consume fails", () => {
  const store = new MemoryPendingActionStore();
  const card = store.create(baseInput());
  const first = store.atomicConsume(card.nonce, APPROVER, {
    nowEpochSeconds: card.createdAt + 1,
  });
  const second = store.atomicConsume(card.nonce, APPROVER, {
    nowEpochSeconds: card.createdAt + 2,
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.reason, "ALREADY_CONSUMED");
});

test("expired card cannot be consumed", () => {
  const store = new MemoryPendingActionStore();
  const card = store.create(baseInput({ createdAt: 1_000, ttlSeconds: 60 }));
  const result = store.atomicConsume(card.nonce, APPROVER, {
    nowEpochSeconds: 1_000 + 60,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, "EXPIRED");
  assert.equal(store.get(card.nonce)?.status, "expired");
});

test("get returns null for unknown nonce", () => {
  const store = new MemoryPendingActionStore();
  assert.equal(store.get("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"), null);
});
