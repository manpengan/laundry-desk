import assert from "node:assert/strict";
import test from "node:test";

import type {
  CustomerPortalGarmentProgressResult,
  CustomerPortalOrderGetResult,
  CustomerPortalReceiptResult,
} from "@laundry/contracts";

import { createPgPool, resolvePgUrls, type PgPoolClient } from "../db/pg-pool.js";
import { createPgCustomerPortalStore } from "./pg-store.js";
import { CustomerPortalSessionInvalidError } from "./types.js";

const enabled =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true";
const urls = enabled ? resolvePgUrls(process.env) : null;
const NOW = new Date("2026-08-13T02:00:00.000Z");
const IDS = Object.freeze({
  org: "a1000000-0000-4000-8000-000000000001",
  store: "a2000000-0000-4000-8000-000000000001",
  otherStore: "a2000000-0000-4000-8000-000000000002",
  staff: "a3000000-0000-4000-8000-000000000001",
  role: "a3000000-0000-4000-8000-000000000002",
  customer: "a4000000-0000-4000-8000-000000000001",
  mergedCustomer: "a4000000-0000-4000-8000-000000000002",
  otherCustomer: "a4000000-0000-4000-8000-000000000003",
  order: "a5000000-0000-4000-8000-000000000001",
  otherOrder: "a5000000-0000-4000-8000-000000000002",
  otherStoreOrder: "a5000000-0000-4000-8000-000000000003",
  line: "a6000000-0000-4000-8000-000000000001",
  garment: "a7000000-0000-4000-8000-000000000001",
  status: "a8000000-0000-4000-8000-000000000001",
  payment: "a9000000-0000-4000-8000-000000000001",
  feature: "aa000000-0000-4000-8000-000000000001",
  otherFeature: "aa000000-0000-4000-8000-000000000002",
});

async function waitForAdvisoryWait(admin: PgPoolClient, pid: number, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await admin.query<Readonly<{ wait_event: string | null }>>(
      "SELECT wait_event FROM pg_stat_activity WHERE pid=$1",
      [pid],
    );
    if (result.rows[0]?.wait_event === "advisory") return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label} did not wait on the org advisory lock`);
}

async function setStaffContext(client: PgPoolClient): Promise<void> {
  await client.query("SELECT set_config('app.org_id',$1,true)", [IDS.org]);
  await client.query("SELECT set_config('app.store_id',$1,true)", [IDS.store]);
  await client.query("SELECT set_config('app.staff_id',$1,true)", [IDS.staff]);
}

async function seed(client: PgPoolClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO orgs (id, code, name, created_at, updated_at)
       VALUES ($1, 'item10_pg', 'Item 10 PG', $2, $2)`,
      [IDS.org, NOW],
    );
    await client.query(
      `INSERT INTO stores (id, org_id, code, name, timezone, created_at, updated_at)
       VALUES ($1,$3,'main','Portal Main','Asia/Taipei',$4,$4),
              ($2,$3,'other','Portal Other','Asia/Taipei',$4,$4)`,
      [IDS.store, IDS.otherStore, IDS.org, NOW],
    );
    await client.query(
      `INSERT INTO staffs
         (id, org_id, username, password_hash, display_name, created_at, updated_at)
       VALUES ($1,$2,'item10-staff','test-only','Item 10 Staff',$3,$3)`,
      [IDS.staff, IDS.org, NOW],
    );
    await client.query(
      `INSERT INTO staff_store_roles
         (id, org_id, store_id, staff_id, role, is_active, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'admin',true,$5,$5)`,
      [IDS.role, IDS.org, IDS.store, IDS.staff, NOW],
    );
    await client.query(
      `INSERT INTO store_features (id, org_id, store_id, updated_at, customer_portal)
       VALUES ($1,$3,$4,$5,false), ($2,$3,$6,$5,true)`,
      [IDS.feature, IDS.otherFeature, IDS.org, IDS.store, NOW, IDS.otherStore],
    );
    await client.query(
      `INSERT INTO customers
         (id, org_id, phone, name, note, created_at, updated_at, merged_into_id, merged_at)
       VALUES ($1,$4,'13800001001','Canonical','internal-root',$5,$5,NULL,NULL),
              ($2,$4,'13800001002','Merged','internal-source',$5,$5,$1,$5),
              ($3,$4,'13800001003','Other','internal-other',$5,$5,NULL,NULL)`,
      [IDS.customer, IDS.mergedCustomer, IDS.otherCustomer, IDS.org, NOW],
    );
    await client.query(
      `INSERT INTO orders (
         id, org_id, store_id, ticket_no, status, customer_phone, customer_name, note,
         subtotal_cents, original_cents, discount_cents, addon_cents, urgent_cents,
         freight_cents, payable_cents, paid_cents, balance_cents, created_at, updated_at,
         created_by_staff_id, business_date, pickup_code, customer_id
       ) VALUES
         ($1,$4,$5,'I10-001','open','13800001002','Merged','private-order',2500,2500,
          200,100,0,100,2500,1000,1500,$7,$7,$6,'2026-08-13','PK-I10-1',$8),
         ($2,$4,$5,'I10-002','open','13800001003','Other','private-other',900,900,
          0,0,0,0,900,0,900,$7,$7,$6,'2026-08-13','PK-I10-2',$9),
         ($3,$4,$10,'I10-003','open','13800001001','Canonical','private-store',700,700,
          0,0,0,0,700,0,700,$7,$7,$6,'2026-08-13','PK-I10-3',$11)`,
      [
        IDS.order,
        IDS.otherOrder,
        IDS.otherStoreOrder,
        IDS.org,
        IDS.store,
        IDS.staff,
        NOW,
        IDS.mergedCustomer,
        IDS.otherCustomer,
        IDS.otherStore,
        IDS.customer,
      ],
    );
    await client.query(
      `INSERT INTO order_lines
         (id, org_id, store_id, order_id, line_index, service_code, category_code,
          unit_price_cents, qty, line_total_cents, color, brand)
       VALUES ($1,$2,$3,$4,0,'wash','shirt',2500,1,2500,'blue','Safe Brand')`,
      [IDS.line, IDS.org, IDS.store, IDS.order],
    );
    await client.query(
      `INSERT INTO garments
         (id, org_id, store_id, order_id, order_line_id, seq, barcode, service_code,
          category_code, unit_price_cents, color, brand, status, note)
       VALUES ($1,$2,$3,$4,$5,1,'I10-PRIVATE-BARCODE','wash','shirt',2500,
               'blue','Safe Brand','washing','private-garment')`,
      [IDS.garment, IDS.org, IDS.store, IDS.order, IDS.line],
    );
    await client.query(
      `INSERT INTO garment_status_log
         (id, org_id, store_id, order_id, garment_id, from_status, to_status, reason,
          staff_id, at)
       VALUES ($1,$2,$3,$4,$5,'received','washing','internal-reason',$6,$7)`,
      [IDS.status, IDS.org, IDS.store, IDS.order, IDS.garment, IDS.staff, NOW],
    );
    await client.query(
      `INSERT INTO payments
         (id, org_id, store_id, order_id, method, amount_cents, kind, staff_id, at,
          note, business_date)
       VALUES ($1,$2,$3,$4,'balance',1000,'pay',$5,$6,'internal-payment','2026-08-13')`,
      [IDS.payment, IDS.org, IDS.store, IDS.order, IDS.staff, NOW],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function cleanup(client: PgPoolClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL session_replication_role = replica");
    for (const table of [
      "customer_portal_access_log",
      "customer_portal_sessions",
      "garment_status_log",
      "payments",
      "garments",
      "order_lines",
      "orders",
      "customer_phone_history",
      "customers",
      "store_features",
      "staff_store_roles",
      "staffs",
      "stores",
    ]) {
      await client.query(`DELETE FROM ${table} WHERE org_id = $1`, [IDS.org]);
    }
    await client.query("DELETE FROM orgs WHERE id = $1", [IDS.org]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

test(
  "real PG portal enforces feature, canonical customer, store, RLS, receipts and revocation",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const adminPool = createPgPool({ connectionString: urls.admin });
    const appPool = createPgPool({ connectionString: urls.app });
    const admin = await adminPool.connect();
    const store = createPgCustomerPortalStore(appPool);
    const sessionHash = "1".repeat(64);
    const csrfHash = "2".repeat(64);
    const authorityHash = "3".repeat(64);
    const secrets = Object.freeze({ sessionHash, csrfHash, authorityHash });
    try {
      await cleanup(admin);
      await seed(admin);
      const loginInput = Object.freeze({
        org_code: "item10_pg",
        store_code: "main",
        phone: "13800001002",
        pickup_code: "PK-I10-1",
      });
      assert.equal(await store.createSession(loginInput, secrets), null);
      await admin.query(
        "UPDATE store_features SET customer_portal=true WHERE org_id=$1 AND store_id=$2",
        [IDS.org, IDS.store],
      );
      assert.equal(
        await store.createSession({ ...loginInput, org_code: "missing" }, secrets),
        null,
      );
      const identity = await store.createSession(loginInput, secrets);
      assert.ok(identity);
      assert.equal(
        identity.customerId,
        IDS.customer,
        "merged profile must resolve to canonical root",
      );
      assert.equal(identity.authorityHash, authorityHash);
      await assert.rejects(
        store.executeQuery(
          { ...identity, authorityHash: "4".repeat(64) },
          sessionHash,
          "customer.self_service.orders.list",
          {},
        ),
        CustomerPortalSessionInvalidError,
      );
      const list = await store.executeQuery(
        identity,
        sessionHash,
        "customer.self_service.orders.list",
        { limit: 20 },
      );
      assert.deepEqual(
        (list as { orders: readonly { order_id: string }[] }).orders.map((row) => row.order_id),
        [IDS.order],
      );
      const crossCustomer = await store.executeQuery(
        identity,
        sessionHash,
        "customer.self_service.order.get",
        { order_id: IDS.otherOrder },
      );
      assert.equal(crossCustomer, null);
      const receipt = (await store.executeQuery(
        identity,
        sessionHash,
        "customer.self_service.receipt.get",
        { order_id: IDS.order },
      )) as CustomerPortalReceiptResult;
      assert.equal(receipt.receipt.payable_cents, 2500);
      assert.equal(receipt.receipt.payments[0]?.amount_cents, 1000);
      assert.equal(receipt.receipt.payments[0]?.method, "balance");
      assert.doesNotMatch(JSON.stringify(receipt), /private|internal|staff|barcode|reason/iu);
      const order = (await store.executeQuery(
        identity,
        sessionHash,
        "customer.self_service.order.get",
        { order_id: IDS.order },
      )) as CustomerPortalOrderGetResult;
      assert.equal(order.lines[0]?.line_total_cents, 2500);
      const progress = (await store.executeQuery(
        identity,
        sessionHash,
        "customer.self_service.garment.progress",
        { order_id: IDS.order, garment_id: IDS.garment },
      )) as CustomerPortalGarmentProgressResult;
      assert.deepEqual(
        progress.progress.map((row) => row.to_status),
        ["washing"],
      );
      assert.doesNotMatch(JSON.stringify(progress), /barcode|reason|staff|private|internal/iu);
      const noContext = await appPool.query<{ count: string }>("SELECT count(*) FROM orders");
      assert.equal(
        noContext.rows[0]?.count,
        "0",
        "forced RLS must fail closed without tenant GUCs",
      );
      assert.equal(await store.revokeSession(sessionHash, csrfHash, "4".repeat(64)), false);
      assert.equal(await store.revokeSession(sessionHash, csrfHash, authorityHash), true);
      await assert.rejects(
        store.executeQuery(identity, sessionHash, "customer.self_service.orders.list", {}),
        CustomerPortalSessionInvalidError,
      );

      const sessionSecrets = (seed: number) =>
        Object.freeze({
          sessionHash: seed.toString(16).padStart(64, "0"),
          csrfHash: (seed + 20).toString(16).padStart(64, "0"),
          authorityHash: (seed + 40).toString(16).padStart(64, "0"),
        });

      const directMergeClient = await appPool.connect();
      try {
        await directMergeClient.query("BEGIN");
        await setStaffContext(directMergeClient);
        await assert.rejects(
          directMergeClient.query(
            `UPDATE customers
                SET merged_into_id=$2::uuid, merged_at=statement_timestamp()
              WHERE org_id=$3::uuid AND id=$1::uuid`,
            [IDS.otherCustomer, IDS.customer, IDS.org],
          ),
          (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "42501",
          "laundry_app must not update canonical merge columns directly",
        );
      } finally {
        await directMergeClient.query("ROLLBACK");
        directMergeClient.release();
      }

      for (let index = 1; index <= 5; index += 1) {
        assert.ok(await store.createSession(loginInput, sessionSecrets(100 + index)));
        assert.ok(
          await store.createSession(
            {
              ...loginInput,
              phone: "13800001003",
              pickup_code: "PK-I10-2",
            },
            sessionSecrets(200 + index),
          ),
        );
      }
      const lockClient = await adminPool.connect();
      const mergeClient = await appPool.connect();
      const concurrentLoginClient = await appPool.connect();
      try {
        await lockClient.query("BEGIN");
        await lockClient.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,42))", [
          IDS.org,
        ]);
        await mergeClient.query("BEGIN");
        await setStaffContext(mergeClient);
        const mergePid = await mergeClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const loginPid = await concurrentLoginClient.query<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid",
        );
        const mergePromise = mergeClient.query(
          "SELECT * FROM customer_merge_canonical($1::uuid,$2::uuid,$3)",
          [IDS.otherCustomer, IDS.customer, new Date(NOW.getTime() + 1_000)],
        );
        assert.ok(mergePid.rows[0]);
        assert.ok(loginPid.rows[0]);
        await waitForAdvisoryWait(admin, mergePid.rows[0].pid, "canonical merge");
        const loginSecrets = sessionSecrets(999);
        const loginPromise = concurrentLoginClient.query(
          `SELECT * FROM customer_portal_session_create($1,$2,$3,$4,$5,$6,$7)`,
          [
            "item10_pg",
            "main",
            "13800001001",
            "PK-I10-2",
            loginSecrets.sessionHash,
            loginSecrets.csrfHash,
            loginSecrets.authorityHash,
          ],
        );
        await waitForAdvisoryWait(admin, loginPid.rows[0].pid, "portal login");
        const tupleLocks = await admin.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM pg_locks
            WHERE pid = ANY($1::integer[]) AND locktype='tuple'`,
          [[mergePid.rows[0].pid, loginPid.rows[0].pid]],
        );
        assert.equal(
          tupleLocks.rows[0]?.count,
          "0",
          "merge and login must acquire the org advisory lock before customer row locks",
        );
        const cancelled = await admin.query<{ cancelled: boolean }>(
          "SELECT pg_cancel_backend($1) AS cancelled",
          [loginPid.rows[0].pid],
        );
        assert.equal(cancelled.rows[0]?.cancelled, true);
        await assert.rejects(
          loginPromise,
          (error: unknown) =>
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "57014",
        );
        await lockClient.query("COMMIT");
        const merged = await mergePromise;
        assert.equal(merged.rowCount, 1);
        await mergeClient.query("COMMIT");
      } catch (error) {
        await Promise.allSettled([
          lockClient.query("ROLLBACK"),
          mergeClient.query("ROLLBACK"),
          concurrentLoginClient.query("ROLLBACK"),
        ]);
        throw error;
      } finally {
        lockClient.release();
        mergeClient.release();
        concurrentLoginClient.release();
      }
      const activeImmediatelyAfterMerge = await admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM customer_portal_sessions
          WHERE org_id=$1 AND status='active' AND customer_id = ANY($2::uuid[])`,
        [IDS.org, [IDS.customer, IDS.otherCustomer]],
      );
      assert.equal(
        activeImmediatelyAfterMerge.rows[0]?.count,
        "5",
        "merge must enforce the canonical-group session cap in its transaction",
      );
      assert.ok(
        await store.createSession(
          { ...loginInput, phone: "13800001001", pickup_code: "PK-I10-2" },
          sessionSecrets(999),
        ),
      );
      const activeAfterMerge = await admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM customer_portal_sessions
          WHERE org_id=$1 AND status='active'
            AND customer_id = ANY($2::uuid[])`,
        [IDS.org, [IDS.customer, IDS.otherCustomer]],
      );
      assert.equal(
        activeAfterMerge.rows[0]?.count,
        "5",
        "the next login must preserve the merged canonical-group session cap",
      );
    } finally {
      try {
        await cleanup(admin);
      } finally {
        admin.release();
        await Promise.all([adminPool.end(), appPool.end()]);
      }
    }
  },
);
