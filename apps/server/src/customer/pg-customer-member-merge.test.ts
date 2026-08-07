import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import { createPgPool, resolvePgUrls } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { DEMO_ADMIN_ID, DEMO_ORG_ID, DEMO_STORE_ID } from "../local/demo-ids.js";
import { seedPgTestIdentityFixture } from "../local/pg-test-fixture.js";
import { createPgMemberStore } from "../member/pg-store.js";
import { mergeCustomerRows } from "./pg-customer-merge.js";
import { createPgCustomerStore } from "./pg-customer-store.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const maybe = urls === null ? test.skip : test;

const TENANT: TenantContext = Object.freeze({
  orgId: DEMO_ORG_ID,
  storeId: DEMO_STORE_ID,
  staffId: DEMO_ADMIN_ID,
});

async function ensureIdentityFixture(): Promise<void> {
  const pool = createPgPool({ connectionString: urls!.admin });
  try {
    await seedPgTestIdentityFixture(pool);
  } finally {
    await pool.end();
  }
}

async function seedCustomers(): Promise<readonly [string, string]> {
  await ensureIdentityFixture();
  const sourceId = randomUUID();
  const targetId = randomUUID();
  const pool = createPgPool({ connectionString: urls!.app });
  try {
    await withPoolClient(pool, async (client) =>
      withTenantTransaction(client, TENANT, async (tx) => {
        for (const [id, phone, name] of [
          [sourceId, `source-${randomUUID()}`, "来源"],
          [targetId, `target-${randomUUID()}`, "保留"],
        ] as const) {
          await tx.query(
            `INSERT INTO customers (id, org_id, phone, name, created_at, updated_at)
             VALUES ($1::uuid, $2::uuid, $3, $4, now(), now())`,
            [id, TENANT.orgId, phone, name],
          );
        }
      }),
    );
  } finally {
    await pool.end();
  }
  return Object.freeze([sourceId, targetId]);
}

async function withMemberStore<T>(
  run: (store: ReturnType<typeof createPgMemberStore>) => Promise<T>,
): Promise<T> {
  const pool = createPgPool({ connectionString: urls!.app });
  try {
    return await withPoolClient(pool, async (client) =>
      withTenantTransaction(client, TENANT, async (tx) => run(createPgMemberStore(tx, TENANT))),
    );
  } finally {
    await pool.end();
  }
}

async function openAccount(customerId: string) {
  return withMemberStore((store) =>
    store.openAccount({ customer_id: customerId, store_id: TENANT.storeId, at: 1_780_000_000 }),
  );
}

async function mergeCustomers(sourceId: string, targetId: string) {
  const pool = createPgPool({ connectionString: urls!.app });
  try {
    return await createPgCustomerStore(pool, { orgId: TENANT.orgId }).merge({
      source_customer_id: sourceId,
      target_customer_id: targetId,
      store_id: TENANT.storeId,
      now: 1_780_000_100,
    });
  } finally {
    await pool.end();
  }
}

function deferred(): Readonly<{ promise: Promise<void>; resolve: () => void }> {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return Object.freeze({ promise, resolve });
}

maybe("an in-flight account open serializes before merge and its account is moved", async () => {
  const [sourceId, targetId] = await seedCustomers();
  const pool = createPgPool({ connectionString: urls!.app, max: 2 });
  const openClient = await pool.connect();
  const mergeClient = await pool.connect();
  const openReady = deferred();
  const allowOpenCommit = deferred();
  const mergeLockStarted = deferred();
  try {
    const openSql = openClient as unknown as SqlClient;
    const mergeSqlBase = mergeClient as unknown as SqlClient;
    const mergeSql: SqlClient = Object.freeze({
      query: <TRow = unknown>(sql: string, params?: readonly unknown[]) => {
        if (sql.includes("FROM customers") && sql.includes("FOR UPDATE")) {
          mergeLockStarted.resolve();
        }
        return mergeSqlBase.query<TRow>(sql, params);
      },
    });

    const opening = withTenantTransaction(openSql, TENANT, async (tx) => {
      const outcome = await createPgMemberStore(tx, TENANT).openAccount({
        customer_id: sourceId,
        store_id: TENANT.storeId,
        at: 1_780_000_000,
      });
      openReady.resolve();
      await allowOpenCommit.promise;
      return outcome;
    });
    await openReady.promise;

    const merging = withTenantTransaction(mergeSql, TENANT, (tx) =>
      mergeCustomerRows(tx, TENANT.orgId, {
        source_customer_id: sourceId,
        target_customer_id: targetId,
        store_id: TENANT.storeId,
        now: 1_780_000_100,
      }),
    );
    await mergeLockStarted.promise;
    allowOpenCommit.resolve();

    const [opened, merged] = await Promise.all([opening, merging]);
    assert.equal(opened.ok, true);
    assert.notEqual(merged, null);
    if (!opened.ok) return;
    assert.equal(await withMemberStore((store) => store.getByCustomer(sourceId, 10)), null);
    assert.equal(
      (await withMemberStore((store) => store.getByCustomer(targetId, 10)))?.account.account_id,
      opened.value.account.account_id,
    );
    assert.deepEqual(await openAccount(sourceId), { ok: false, reason: "customer_not_found" });
  } finally {
    allowOpenCommit.resolve();
    openClient.release();
    mergeClient.release();
    await pool.end();
  }
});

maybe("customer merge keeps a target-only member account", async () => {
  const [sourceId, targetId] = await seedCustomers();
  const opened = await openAccount(targetId);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  assert.notEqual(await mergeCustomers(sourceId, targetId), null);
  const retained = await withMemberStore((store) => store.getByCustomer(targetId, 10));
  assert.equal(retained?.account.account_id, opened.value.account.account_id);
  assert.equal(await withMemberStore((store) => store.getByCustomer(sourceId, 10)), null);
});

maybe("customer merge refuses two member accounts without partial changes", async () => {
  const [sourceId, targetId] = await seedCustomers();
  const source = await openAccount(sourceId);
  const target = await openAccount(targetId);
  assert.equal(source.ok, true);
  assert.equal(target.ok, true);

  assert.equal(await mergeCustomers(sourceId, targetId), null);
  assert.notEqual(await withMemberStore((store) => store.getByCustomer(sourceId, 10)), null);
  assert.notEqual(await withMemberStore((store) => store.getByCustomer(targetId, 10)), null);

  const pool = createPgPool({ connectionString: urls!.app });
  try {
    assert.notEqual(
      await createPgCustomerStore(pool, { orgId: TENANT.orgId }).getById(sourceId),
      null,
    );
  } finally {
    await pool.end();
  }
});
