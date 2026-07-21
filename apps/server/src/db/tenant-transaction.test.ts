import assert from "node:assert/strict";
import test from "node:test";

import { FakeSqlClient } from "./fake-client.js";
import { TENANT_GUC_KEYS, TenantGucError } from "./guc.js";
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
