import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { MemoryApprovalStore } from "../approvals/memory-store.js";
import { FakeSqlClient } from "../db/fake-client.js";
import type { TenantContext } from "../db/types.js";
import { MemoryPendingActionStore } from "../pending-actions/store.js";
import { consumeConfirmation } from "./consume-confirmation.js";
import { createM1CommandRegistry } from "./registry.js";
import type { BusContext } from "./types.js";

const ORG = randomUUID();
const STORE = randomUUID();
const REQUESTER = randomUUID();
const APPROVER = randomUUID();
const NOW = 1_900_000_000;

const tenant = (staffId: string): TenantContext =>
  Object.freeze({ orgId: ORG, storeId: STORE, staffId });

test("async R4 approval and its frozen pending card are consumed in one bus continuation", async () => {
  const client = new FakeSqlClient();
  const pendingStore = new MemoryPendingActionStore();
  const approvalStore = new MemoryApprovalStore();
  const pending = pendingStore.create({
    nonce: randomUUID(),
    command: "payment.refund",
    commandVersion: "0.2.0",
    args: Object.freeze({
      order_id: randomUUID(),
      amount_cents: 100,
      method: "cash",
      ref_payment_id: randomUUID(),
      reason: "duplicate capture",
    }),
    entityVersions: Object.freeze([
      Object.freeze({ entityType: "payment", entityId: randomUUID(), version: 3 }),
    ]),
    creatorStaffId: REQUESTER,
    orgId: ORG,
    storeId: STORE,
    idempotencyKey: randomUUID(),
    createdAt: NOW,
    ttlSeconds: 300,
    effectiveRisk: "R4",
    policyOutcome: "step_up",
    requiresOtherApprover: true,
  });
  const requesterTransaction = Object.freeze({ tenant: tenant(REQUESTER), client });
  const created = await approvalStore.create(randomUUID(), pending, 4, requesterTransaction);
  const approved = await approvalStore.decide(
    created.approvalRef,
    created.rowVersion,
    "approved",
    null,
    7,
    NOW + 1,
    Object.freeze({ tenant: tenant(APPROVER), client }),
  );
  const definition = createM1CommandRegistry().get(pending.command)?.definition;
  assert.ok(definition);
  const context: BusContext = Object.freeze({
    tenant: tenant(REQUESTER),
    actor: Object.freeze({ staffId: REQUESTER, deviceId: null, via: "ai", riskCap: "R4" }),
    request: Object.freeze({
      name: pending.command,
      version: pending.commandVersion,
      input: pending.args,
      dryRun: false,
      idempotencyKey: pending.idempotencyKey,
      confirmRef: pending.nonce,
    }),
    definition,
    confirmAuthorized: true,
    confirmAuthorization: Object.freeze({
      confirmRef: pending.nonce,
      argsHash: pending.argsHash,
      effectiveRisk: "R4",
      policyOutcome: "step_up",
      requiresOtherApprover: true,
    }),
  });

  const evidence = await consumeConfirmation(client, context, {
    pendingStore,
    approvalStore,
    approvalRef: approved.approvalRef,
    now: new Date((NOW + 2) * 1_000),
  });

  assert.deepEqual(evidence, {
    initiatedByStaffId: REQUESTER,
    approvedByStaffId: APPROVER,
  });
  assert.equal(pendingStore.get(pending.nonce)?.status, "consumed");
  assert.equal(
    (await approvalStore.get(approved.approvalRef, NOW + 2, { tenant: tenant(REQUESTER) }))?.status,
    "consumed",
  );
});
