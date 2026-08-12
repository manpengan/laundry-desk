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
      staff_id: TENANT.staffId,
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
        if (
          sql.includes("customer_merge_canonical") ||
          (sql.includes("FROM customers") && sql.includes("FOR UPDATE"))
        ) {
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
        staff_id: TENANT.staffId,
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

maybe("recursive A to B to C merge flattens the group and relinks every store order", async () => {
  assert.ok(urls);
  const adminPool = createPgPool({ connectionString: urls.admin });
  const appPool = createPgPool({ connectionString: urls.app });
  const customerA = randomUUID();
  const customerB = randomUUID();
  const customerC = randomUUID();
  const secondStore = randomUUID();
  const orderA = randomUUID();
  const orderB = randomUUID();
  const privacyEventId = randomUUID();
  const customerIds = Object.freeze([customerA, customerB, customerC]);
  try {
    await seedPgTestIdentityFixture(adminPool);
    await adminPool.query(
      `INSERT INTO stores (id, org_id, code, name, timezone, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'Merge Second Store', 'Asia/Shanghai', now(), now())`,
      [secondStore, DEMO_ORG_ID, `merge-${secondStore.slice(0, 12)}`],
    );
    await adminPool.query(
      `INSERT INTO customers (id, org_id, phone, name, created_at, updated_at)
       VALUES
         ($1::uuid, $4::uuid, $5, 'Merge A', now(), now()),
         ($2::uuid, $4::uuid, $6, 'Merge B', now(), now()),
         ($3::uuid, $4::uuid, $7, 'Merge C', now(), now())`,
      [
        customerA,
        customerB,
        customerC,
        DEMO_ORG_ID,
        `a-${randomUUID()}`,
        `b-${randomUUID()}`,
        `c-${randomUUID()}`,
      ],
    );
    await adminPool.query(
      `INSERT INTO orders (
         id, org_id, store_id, ticket_no, status, customer_phone, customer_name,
         subtotal_cents, original_cents, discount_cents, addon_cents, urgent_cents,
         freight_cents, payable_cents, paid_cents, balance_cents,
         created_at, updated_at, created_by_staff_id, business_date, customer_id
       ) VALUES
         ($1::uuid, $3::uuid, $4::uuid, $5, 'open', 'merge-a', 'Merge A',
          500, 500, 0, 0, 0, 0, 500, 0, 500,
          now(), now(), $6::uuid, '2026-08-12', $7::uuid),
         ($2::uuid, $3::uuid, $8::uuid, $9, 'open', 'merge-b', 'Merge B',
          700, 700, 0, 0, 0, 0, 700, 0, 700,
          now(), now(), $6::uuid, '2026-08-12', $10::uuid)`,
      [
        orderA,
        orderB,
        DEMO_ORG_ID,
        DEMO_STORE_ID,
        `MERGE-A-${orderA.slice(0, 8)}`,
        DEMO_ADMIN_ID,
        customerA,
        secondStore,
        `MERGE-B-${orderB.slice(0, 8)}`,
        customerB,
      ],
    );
    await adminPool.query(
      `INSERT INTO customer_privacy_events (
         id, org_id, customer_id, action, reason, affected_order_count,
         origin_store_id, staff_id, created_at
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, 'exported', 'customer_request', 0,
         $4::uuid, $5::uuid, to_timestamp(10)
       )`,
      [privacyEventId, DEMO_ORG_ID, customerA, DEMO_STORE_ID, DEMO_ADMIN_ID],
    );

    const customers = createPgCustomerStore(appPool, { orgId: DEMO_ORG_ID });
    const first = await customers.merge({
      source_customer_id: customerA,
      target_customer_id: customerB,
      store_id: DEMO_STORE_ID,
      staff_id: DEMO_ADMIN_ID,
      now: 1_775_174_600,
    });
    assert.equal(first?.relinked_order_count, 1);
    const second = await customers.merge({
      source_customer_id: customerB,
      target_customer_id: customerC,
      store_id: DEMO_STORE_ID,
      staff_id: DEMO_ADMIN_ID,
      now: 1_775_174_601,
    });
    assert.equal(second?.source_customer_id, customerB);
    assert.equal(second?.target_customer_id, customerC);
    assert.equal(second?.relinked_order_count, 2);

    const resolveCanonicalId = customers.resolveCanonicalId;
    const listCanonicalGroup = customers.listCanonicalGroup;
    assert.ok(resolveCanonicalId);
    assert.ok(listCanonicalGroup);
    assert.equal(await resolveCanonicalId(customerA), customerC);
    assert.equal(await resolveCanonicalId(customerB), customerC);
    assert.equal(await resolveCanonicalId(customerC), customerC);
    assert.deepEqual([...(await listCanonicalGroup(customerA))].sort(), [...customerIds].sort());
    for (const customerId of customerIds) {
      const events = await customers.listPrivacyEvents(customerId, 20);
      assert.equal(events.length, 1);
      assert.equal(events[0]?.event_id, privacyEventId);
      assert.equal(events[0]?.customer_id, customerA);
    }
    const linked = await adminPool.query<
      Readonly<{
        id: string;
        customer_id: string;
        customer_name: string | null;
        store_id: string;
      }>
    >(
      `SELECT id::text, customer_id::text, customer_name, store_id::text
         FROM orders
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [[orderA, orderB]],
    );
    assert.equal(linked.rows.length, 2);
    assert.equal(
      linked.rows.every((row) => row.customer_id === customerC),
      true,
    );
    assert.equal(
      linked.rows.every((row) => row.customer_name === "Merge C"),
      true,
    );
    assert.deepEqual(
      linked.rows.map((row) => row.store_id).sort(),
      [DEMO_STORE_ID, secondStore].sort(),
    );
  } finally {
    await adminPool.query("DELETE FROM customer_privacy_events WHERE id = $1::uuid", [
      privacyEventId,
    ]);
    await adminPool.query("DELETE FROM orders WHERE id = ANY($1::uuid[])", [[orderA, orderB]]);
    await adminPool.query("DELETE FROM customers WHERE id = ANY($1::uuid[])", [customerIds]);
    await adminPool.query("DELETE FROM stores WHERE id = $1::uuid", [secondStore]);
    await Promise.all([appPool.end(), adminPool.end()]);
  }
});

maybe("customer merge refuses a combined canonical group above the privacy bound", async () => {
  assert.ok(urls);
  const adminPool = createPgPool({ connectionString: urls.admin });
  const appPool = createPgPool({ connectionString: urls.app });
  const sourceRoot = randomUUID();
  const targetRoot = randomUUID();
  const sourceChildren = Object.freeze(Array.from({ length: 499 }, () => randomUUID()));
  const targetChildren = Object.freeze(Array.from({ length: 500 }, () => randomUUID()));
  const childIds = Object.freeze([...sourceChildren, ...targetChildren]);
  try {
    await seedPgTestIdentityFixture(adminPool);
    await adminPool.query(
      `INSERT INTO customers (id, org_id, phone, name, created_at, updated_at)
       VALUES
         ($1::uuid, $3::uuid, $4, 'Bound Source Root', now(), now()),
         ($2::uuid, $3::uuid, $5, 'Bound Target Root', now(), now())`,
      [
        sourceRoot,
        targetRoot,
        DEMO_ORG_ID,
        `bound-source-${sourceRoot}`,
        `bound-target-${targetRoot}`,
      ],
    );
    await adminPool.query(
      `INSERT INTO customers (
         id, org_id, phone, name, merged_into_id, merged_at, created_at, updated_at
       )
       SELECT child.id, $1::uuid, child.phone, 'Bound Source Child', $2::uuid,
              now(), now(), now()
         FROM unnest($3::uuid[], $4::text[]) AS child(id, phone)`,
      [DEMO_ORG_ID, sourceRoot, sourceChildren, sourceChildren.map((id) => `bound-source-${id}`)],
    );
    await adminPool.query(
      `INSERT INTO customers (
         id, org_id, phone, name, merged_into_id, merged_at, created_at, updated_at
       )
       SELECT child.id, $1::uuid, child.phone, 'Bound Target Child', $2::uuid,
              now(), now(), now()
         FROM unnest($3::uuid[], $4::text[]) AS child(id, phone)`,
      [DEMO_ORG_ID, targetRoot, targetChildren, targetChildren.map((id) => `bound-target-${id}`)],
    );

    const customers = createPgCustomerStore(appPool, { orgId: DEMO_ORG_ID });
    assert.equal(
      await customers.merge({
        source_customer_id: sourceRoot,
        target_customer_id: targetRoot,
        store_id: DEMO_STORE_ID,
        staff_id: DEMO_ADMIN_ID,
        now: 1_775_174_700,
      }),
      null,
    );
    assert.equal((await customers.listCanonicalGroup?.(sourceRoot))?.length, 500);
    assert.equal((await customers.listCanonicalGroup?.(targetRoot))?.length, 501);
    const roots = await adminPool.query<Readonly<{ id: string; merged_into_id: string | null }>>(
      `SELECT id::text, merged_into_id::text
         FROM customers
        WHERE id = ANY($1::uuid[])
        ORDER BY id`,
      [[sourceRoot, targetRoot]],
    );
    assert.equal(roots.rows.length, 2);
    assert.equal(
      roots.rows.every((row) => row.merged_into_id === null),
      true,
    );
  } finally {
    await adminPool.query("DELETE FROM customers WHERE id = ANY($1::uuid[])", [childIds]);
    await adminPool.query("DELETE FROM customers WHERE id = ANY($1::uuid[])", [
      [sourceRoot, targetRoot],
    ]);
    await Promise.all([appPool.end(), adminPool.end()]);
  }
});
