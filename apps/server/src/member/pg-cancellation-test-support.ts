import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPgPool, type PgPool, type ResolvedPgUrls } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { createPgOrderStore } from "../order/pg-order-store.js";
import { createPgMemberStore } from "./pg-store.js";
import { createPgMemberDeps } from "./runtime.js";
import {
  CANCEL_AT,
  CANCEL_DAY,
  cancellationHandlers,
  runCancellationHandler,
  seedCancellationOrder,
} from "./order-cancellation-test-support.js";

export async function createCancellationFixture(urls: ResolvedPgUrls, bonus = 0) {
  const adminPool = createPgPool({ connectionString: urls.admin });
  const appPool = createPgPool({ connectionString: urls.app, max: 6 });
  const tenant = { orgId: randomUUID(), storeId: randomUUID(), staffId: randomUUID() };
  const customerId = randomUUID();
  await adminPool.query(
    "INSERT INTO orgs (id, code, name, created_at, updated_at) VALUES ($1, $2, 'Cancellation regression', now(), now())",
    [tenant.orgId, `cancel-${tenant.orgId}`],
  );
  await adminPool.query(
    "INSERT INTO stores (id, org_id, code, name, timezone, created_at, updated_at) VALUES ($1, $2, 'main', 'Synthetic', 'UTC', now(), now())",
    [tenant.storeId, tenant.orgId],
  );
  await adminPool.query(
    "INSERT INTO staffs (id, org_id, username, password_hash, display_name, is_active, permission_version, created_at, updated_at) VALUES ($1, $2, 'admin', 'test-only', 'Synthetic', true, 1, now(), now())",
    [tenant.staffId, tenant.orgId],
  );
  const transaction = <T>(
    fn: (store: ReturnType<typeof createPgMemberStore>, client: SqlClient) => Promise<T>,
  ) =>
    withPoolClient(appPool, (client) =>
      withTenantTransaction(client, tenant, (tx) => fn(createPgMemberStore(tx, tenant), tx)),
    );
  await transaction(async (_store, tx) => {
    await tx.query(
      "INSERT INTO customers (id, org_id, phone, created_at, updated_at) VALUES ($1, $2, '13800000000', now(), now())",
      [customerId, tenant.orgId],
    );
  });
  const order = createPgOrderStore(appPool);
  const orderId = await seedCancellationOrder(order, tenant, customerId);
  const handlers = cancellationHandlers(order, createPgMemberDeps());
  const run = (name: string, input: Readonly<Record<string, unknown>>, fail = false) =>
    withPoolClient(appPool, (client) =>
      runCancellationHandler(client, tenant, handlers, name, input, fail),
    );
  const opened = await transaction((store) =>
    store.openAccount({ customer_id: customerId, store_id: tenant.storeId, at: CANCEL_AT }),
  );
  assert.ok(opened.ok);
  const accountId = opened.value.account.account_id;
  if (bonus > 0)
    await transaction((store) =>
      store.upsertBonusRule({
        rule_id: null,
        min_topup_cents: 10000,
        bonus_cents: bonus,
        status: "active",
        staff_id: tenant.staffId,
        at: CANCEL_AT,
        note: null,
      }),
    );
  await run("member.topup", { account_id: accountId, amount_cents: 10000, method: "cash" });
  return {
    tenant,
    customerId,
    accountId,
    orderId,
    order,
    appPool,
    adminPool,
    transaction,
    handlers,
    pay: (amount: number, fail = false) =>
      run(
        "member.balance.pay",
        { account_id: accountId, order_id: orderId, amount_cents: amount },
        fail,
      ),
    cancel: (fail = false) =>
      run("order.cancel", { order_id: orderId, reason: "合成撤单回归" }, fail),
    view: () => transaction((store) => store.getById(accountId, 50)),
    payments: () => order.listPayments!(tenant.orgId, tenant.storeId, orderId),
    cleanup: () => cleanupCancellationFixture(adminPool, appPool, tenant),
  };
}

async function cleanupCancellationFixture(admin: PgPool, app: PgPool, tenant: TenantContext) {
  await app.end();
  try {
    for (const table of [
      "command_idempotency",
      "ai_pending_actions",
      "member_payment_links",
      "member_ledger",
      "member_bonus_rules",
      "member_accounts",
      "audit_log",
      "payments",
      "garments",
      "order_lines",
      "orders",
      "customer_profiles",
      "customers",
      "staff_store_roles",
      "staffs",
      "stores",
      "customer_privacy_hmac_keys",
    ]) {
      await admin.query(`DELETE FROM ${table} WHERE org_id = $1::uuid`, [tenant.orgId]);
    }
    await admin.query("DELETE FROM orgs WHERE id = $1::uuid", [tenant.orgId]);
  } finally {
    await admin.end();
  }
}

export const cancellationLifecycle = (
  f: Awaited<ReturnType<typeof createCancellationFixture>>,
) => ({
  account_id: f.accountId,
  expected_customer_id: f.customerId,
  expected_status_version: 1,
  store_id: f.tenant.storeId,
  staff_id: f.tenant.staffId,
  at: CANCEL_AT,
  reason: "合成生命周期测试",
  business_date: CANCEL_DAY,
});
