import assert from "node:assert/strict";
import test from "node:test";

import { FakeSqlClient } from "./fake-client.js";
import { MemoryPendingActionStore } from "../pending-actions/store.js";
import { MemoryStepUpProofStore } from "../policy/step-up-proof-store.js";
import type { StepUpProof } from "../policy/step-up.js";
import { getActiveTenantTransaction } from "./active-tenant-transaction.js";
import { TENANT_GUC_KEYS, TenantGucError } from "./guc.js";
import type { PgPool } from "./pg-pool.js";
import { withStoreGucOrCurrent } from "./tenant-guc-client.js";
import { withTenantTransaction } from "./tenant-transaction.js";
import { withWorkerTenantTransaction } from "./worker-transaction.js";

const VALID_CTX = Object.freeze({
  orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  storeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  staffId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
});

test("withTenantTransaction applies GUCs then commits on success", async () => {
  const client = new FakeSqlClient();
  const result = await withTenantTransaction(client, VALID_CTX, async (tx) => {
    await tx.query("SELECT 1");
    return 42;
  });

  assert.equal(result, 42);
  assert.deepEqual(client.sqlSequence(), [
    "BEGIN",
    `SELECT set_config('${TENANT_GUC_KEYS.orgId}', $1, true)`,
    `SELECT set_config('${TENANT_GUC_KEYS.storeId}', $1, true)`,
    `SELECT set_config('${TENANT_GUC_KEYS.staffId}', $1, true)`,
    "SELECT 1",
    "COMMIT",
  ]);
  assert.deepEqual(client.queries[1]?.params, [VALID_CTX.orgId]);
  assert.deepEqual(client.queries[2]?.params, [VALID_CTX.storeId]);
  assert.deepEqual(client.queries[3]?.params, [VALID_CTX.staffId]);
});

test("withTenantTransaction exposes only its authenticated tenant to repositories", async () => {
  const client = new FakeSqlClient();
  await withTenantTransaction(client, VALID_CTX, async () => {
    const current = getActiveTenantTransaction();
    assert.ok(current);
    assert.equal(current.client, client);
    assert.deepEqual(current.tenant, VALID_CTX);
  });
  assert.equal(getActiveTenantTransaction(), undefined);
});

test("withTenantTransaction can establish a read-only repeatable snapshot before tenant GUCs", async () => {
  const client = new FakeSqlClient();
  await withTenantTransaction(client, VALID_CTX, async () => undefined, {
    isolation: "repeatable_read",
    readOnly: true,
  });
  assert.equal(client.sqlSequence()[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.ok(client.sqlSequence()[1]?.includes(TENANT_GUC_KEYS.orgId));
});

test("repository GUC helper reuses the command transaction instead of opening a second connection", async () => {
  const client = new FakeSqlClient();
  let poolConnects = 0;
  const pool = {
    connect: async () => {
      poolConnects += 1;
      throw new Error("must not open a nested pool connection");
    },
  } as unknown as PgPool;

  await withTenantTransaction(client, VALID_CTX, async () =>
    withStoreGucOrCurrent(pool, VALID_CTX, async (tx) => {
      assert.equal(tx, client);
      await tx.query("INSERT INTO orders (id) VALUES ($1)", ["order-id"]);
    }),
  );

  assert.equal(poolConnects, 0);
  assert.equal(client.sqlSequence().filter((sql) => sql === "BEGIN").length, 1);
  assert.equal(client.sqlSequence().at(-1), "COMMIT");
});

test("repository GUC helper rejects a store that differs from the authenticated session", async () => {
  const client = new FakeSqlClient();
  const pool = {} as PgPool;
  await assert.rejects(
    () =>
      withTenantTransaction(client, VALID_CTX, async () =>
        withStoreGucOrCurrent(
          pool,
          { ...VALID_CTX, storeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
          async () => undefined,
        ),
      ),
    /does not match authenticated tenant/u,
  );
  assert.equal(client.sqlSequence().at(-1), "ROLLBACK");
});

test("withTenantTransaction rolls back when fn throws", async () => {
  const client = new FakeSqlClient();
  await assert.rejects(
    () =>
      withTenantTransaction(client, VALID_CTX, async () => {
        throw new Error("business failed");
      }),
    /business failed/,
  );

  const sequence = client.sqlSequence();
  assert.equal(sequence[0], "BEGIN");
  assert.equal(sequence[sequence.length - 1], "ROLLBACK");
  assert.equal(sequence.includes("COMMIT"), false);
});

test("withTenantTransaction rolls back when COMMIT fails after fn", async () => {
  const client = new FakeSqlClient();
  client.failOn("COMMIT");
  await assert.rejects(
    () => withTenantTransaction(client, VALID_CTX, async () => "ok"),
    /forced failure on: COMMIT/,
  );
  assert.equal(client.sqlSequence().includes("ROLLBACK"), true);
});

test("memory pending and step-up CAS changes roll back when COMMIT fails", async () => {
  const pending = new MemoryPendingActionStore();
  const action = pending.create({
    nonce: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    command: "garment.mark_lost",
    commandVersion: "0.1.0",
    args: Object.freeze({ garment_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }),
    entityVersions: Object.freeze([]),
    creatorStaffId: VALID_CTX.staffId,
    orgId: VALID_CTX.orgId,
    storeId: VALID_CTX.storeId,
    idempotencyKey: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    createdAt: 1_700_000_000,
    effectiveRisk: "R4",
    policyOutcome: "step_up",
    requiresOtherApprover: true,
  });
  const proof: StepUpProof = Object.freeze({
    proofId: "11111111-1111-4111-8111-111111111111",
    status: "active",
    pendingActionRef: action.nonce,
    argsHash: action.argsHash,
    entityVersions: action.entityVersions,
    idempotencyKey: action.idempotencyKey,
    requesterStaffId: action.creatorStaffId,
    approverStaffId: "22222222-2222-4222-8222-222222222222",
    orgId: action.orgId,
    storeId: action.storeId,
    sessionId: "33333333-3333-4333-8333-333333333333",
    sessionVersion: 1,
    issuedAt: action.createdAt,
    expiresAt: action.expiresAt,
  });
  const proofs = new MemoryStepUpProofStore();
  proofs.insert(proof);
  const client = new FakeSqlClient();
  client.failOn("COMMIT");

  await assert.rejects(
    () =>
      withTenantTransaction(client, VALID_CTX, async () => {
        assert.equal(
          pending.atomicConsume(action.nonce, proof.approverStaffId, {
            nowEpochSeconds: action.createdAt + 1,
          }).ok,
          true,
        );
        assert.equal(proofs.atomicConsume(proof.proofId, action.createdAt + 1), true);
      }),
    /forced failure on: COMMIT/u,
  );

  assert.equal(pending.get(action.nonce)?.status, "pending");
  assert.equal(proofs.get(proof.proofId)?.status, "active");
});

test("invalid tenant context is rejected before BEGIN", async () => {
  const client = new FakeSqlClient();
  await assert.rejects(
    () => withTenantTransaction(client, { orgId: "nope" }, async () => null),
    TenantGucError,
  );
  assert.deepEqual(client.sqlSequence(), []);
});

test("worker path reuses the same GUC injection (no naked connection)", async () => {
  const client = new FakeSqlClient();
  await withWorkerTenantTransaction(client, VALID_CTX, async () => "worker-ok");
  assert.equal(client.sqlSequence()[0], "BEGIN");
  assert.ok(client.sqlSequence().some((sql) => sql.includes(TENANT_GUC_KEYS.orgId)));
  assert.equal(client.sqlSequence().at(-1), "COMMIT");
});
