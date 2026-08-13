import assert from "node:assert/strict";
import test from "node:test";

import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { QueryResult, SqlClient, TenantContext } from "../db/types.js";
import { encryptCredential } from "./byok-envelope.js";
import { MemoryByokStore } from "./byok-memory-store.js";
import { TestByokKms } from "./byok-test-kms.js";
import type { StoredCredential } from "./byok-types.js";

const TENANT: TenantContext = Object.freeze({
  orgId: "11111111-1111-4111-8111-111111111111",
  storeId: "22222222-2222-4222-8222-222222222222",
  staffId: "33333333-3333-4333-8333-333333333333",
});
const OTHER_TENANT: TenantContext = Object.freeze({
  ...TENANT,
  orgId: "44444444-4444-4444-8444-444444444444",
});
const SQL: SqlClient = Object.freeze({
  memoryTransaction: true as const,
  async query<TRow = unknown>(): Promise<QueryResult<TRow>> {
    return Object.freeze({ rows: Object.freeze([]) as readonly TRow[], rowCount: 0 });
  },
});

async function credential(
  id: string,
  version: number,
  at: Date,
  orgId = TENANT.orgId,
): Promise<StoredCredential> {
  const kms = new TestByokKms();
  return Object.freeze({
    id,
    orgId,
    providerCode: "vendor-a",
    credentialVersion: version,
    rowVersion: 1,
    status: "pending_verification" as const,
    envelope: await encryptCredential(
      kms,
      { orgId, providerCode: "vendor-a", credentialId: id },
      Buffer.from(`sk-test-${version}-abcd`, "ascii"),
    ),
    last4: "abcd",
    createdByStaffId: TENANT.staffId,
    createdAt: at,
    updatedByStaffId: TENANT.staffId,
    updatedAt: at,
    activatedAt: null,
    revokedAt: null,
    supersededAt: null,
  });
}

async function transact<T>(
  tenant: TenantContext,
  run: Parameters<typeof withTenantTransaction<T>>[2],
): Promise<T> {
  return withTenantTransaction(SQL, tenant, run);
}

test("rotation stages one pending version and preserves the active credential until activation", async () => {
  const store = new MemoryByokStore();
  const firstAt = new Date("2026-08-13T00:00:00.000Z");
  const secondAt = new Date("2026-08-13T00:01:00.000Z");
  const first = await credential("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 1, firstAt);
  const second = await credential("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 2, secondAt);

  await transact(TENANT, (client) => store.stageCredential(first, { tenant: TENANT, client }));
  await transact(TENANT, (client) =>
    store.activateCredential(first.id, TENANT.staffId, firstAt, { tenant: TENANT, client }),
  );
  await transact(TENANT, (client) => store.stageCredential(second, { tenant: TENANT, client }));

  let rows = await store.listCredentials({ tenant: TENANT });
  assert.equal(rows.find((row) => row.id === first.id)?.status, "active");
  assert.equal(rows.find((row) => row.id === second.id)?.status, "pending_verification");

  await transact(TENANT, (client) =>
    store.activateCredential(second.id, TENANT.staffId, secondAt, { tenant: TENANT, client }),
  );
  rows = await store.listCredentials({ tenant: TENANT });
  assert.equal(rows.find((row) => row.id === first.id)?.status, "superseded");
  assert.equal(rows.find((row) => row.id === second.id)?.status, "active");
});

test("revocation is terminal, org scoped, and rollback preserves the prior state", async () => {
  const store = new MemoryByokStore();
  const now = new Date("2026-08-13T00:00:00.000Z");
  const first = await credential("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 1, now);
  await transact(TENANT, (client) => store.stageCredential(first, { tenant: TENANT, client }));

  assert.equal(await store.findCredential(first.id, { tenant: OTHER_TENANT }), null);
  await assert.rejects(
    transact(TENANT, async (client) => {
      const revoked = await store.revokeCredential(first.id, TENANT.staffId, now, {
        tenant: TENANT,
        client,
      });
      assert.equal(revoked?.status, "revoked");
      throw new Error("force rollback");
    }),
  );
  assert.equal(
    (await store.findCredential(first.id, { tenant: TENANT }))?.status,
    "pending_verification",
  );

  await transact(TENANT, (client) =>
    store.revokeCredential(first.id, TENANT.staffId, now, { tenant: TENANT, client }),
  );
  assert.equal((await store.findCredential(first.id, { tenant: TENANT }))?.status, "revoked");
  assert.equal(
    await transact(TENANT, (client) =>
      store.activateCredential(first.id, TENANT.staffId, now, { tenant: TENANT, client }),
    ),
    null,
  );
});
