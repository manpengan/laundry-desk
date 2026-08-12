import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { createPgPool, resolvePgUrls, type PgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { TenantContext } from "../db/types.js";
import { createPgPendingActionStore } from "../pending-actions/pg-store.js";
import {
  NOTIFICATION_ACTIVE_PENDING_LIMIT,
  NOTIFICATION_ROLLING_PENDING_LIMIT,
  PendingRiskCapacityExceededError,
} from "../pending-actions/types.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const maybe = urls === null ? test.skip : test;

async function seed(adminPool: PgPool): Promise<TenantContext> {
  const tenant = Object.freeze({
    orgId: randomUUID(),
    storeId: randomUUID(),
    staffId: randomUUID(),
  });
  const code = tenant.orgId.slice(0, 8);
  await adminPool.query(
    `INSERT INTO orgs (id, code, name, created_at, updated_at)
     VALUES ($1::uuid, $2, 'Notification Risk Org', now(), now())`,
    [tenant.orgId, `notify-risk-${code}`],
  );
  await adminPool.query(
    `INSERT INTO stores (id, org_id, code, name, timezone, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3, 'Notification Risk Store', 'UTC', now(), now())`,
    [tenant.storeId, tenant.orgId, `notify-risk-store-${code}`],
  );
  await adminPool.query(
    `INSERT INTO staffs (
       id, org_id, username, password_hash, pin_hash, display_name,
       is_active, permission_version, created_at, updated_at
     ) VALUES ($1::uuid, $2::uuid, $3, 'hash', 'hash', 'Risk Admin', true, 1, now(), now())`,
    [tenant.staffId, tenant.orgId, `notify-risk-admin-${code}`],
  );
  return tenant;
}

function riskRequest(units: number) {
  return Object.freeze({
    kind: "notification_delivery_rolling_24h" as const,
    command: "notification.delivery_batch.enqueue" as const,
    commandVersion: "0.1.0" as const,
    units,
    threshold: 10 as const,
    windowSeconds: 86_400 as const,
    activePendingLimit: NOTIFICATION_ACTIVE_PENDING_LIMIT,
    rollingPendingLimit: NOTIFICATION_ROLLING_PENDING_LIMIT,
    nowEpochSeconds: 1,
  });
}

function card(tenant: TenantContext, units: number, idempotencyKey: string) {
  return Object.freeze({
    nonce: randomUUID(),
    command: "notification.delivery_batch.enqueue",
    commandVersion: "0.1.0",
    args: Object.freeze({ order_ids: Array.from({ length: units }, () => randomUUID()) }),
    authority: Object.freeze({ kind: "risk-test" }),
    entityVersions: Object.freeze([]),
    creatorStaffId: tenant.staffId,
    orgId: tenant.orgId,
    storeId: tenant.storeId,
    idempotencyKey,
    createdAt: Math.floor(Date.now() / 1_000),
    effectiveRisk: "R3" as const,
    policyOutcome: "confirm" as const,
    requiresOtherApprover: false,
  });
}

maybe("real PG serializes concurrent 6+5 notification risk reservations", async () => {
  assert.ok(urls);
  const adminPool = createPgPool({ connectionString: urls.admin });
  const appPool = createPgPool({ connectionString: urls.app, max: 2 });
  const tenant = await seed(adminPool);
  const firstKey = randomUUID();
  try {
    const firstClient = await appPool.connect();
    const secondClient = await appPool.connect();
    let releaseFirst = (): void => undefined;
    let firstMeasuredResolve = (): void => undefined;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstMeasured = new Promise<void>((resolve) => {
      firstMeasuredResolve = resolve;
    });
    try {
      const first = withTenantTransaction(
        Object.freeze({
          query: (sql: string, params?: readonly unknown[]) =>
            firstClient.query(sql, params as never),
        }),
        tenant,
        async (tx) => {
          const store = createPgPendingActionStore(appPool);
          const measured = await store.measureRiskReservation(riskRequest(6), {
            tenant,
            client: tx,
          });
          await store.create(card(tenant, 6, firstKey), { tenant, client: tx });
          firstMeasuredResolve();
          await holdFirst;
          return measured;
        },
      );
      await firstMeasured;
      let secondFinished = false;
      const second = withTenantTransaction(
        Object.freeze({
          query: (sql: string, params?: readonly unknown[]) =>
            secondClient.query(sql, params as never),
        }),
        tenant,
        async (tx) =>
          createPgPendingActionStore(appPool).measureRiskReservation(riskRequest(5), {
            tenant,
            client: tx,
          }),
      ).finally(() => {
        secondFinished = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(secondFinished, false);
      releaseFirst();
      assert.equal((await first).aggregate_units, 6);
      const secondResult = await second;
      assert.equal(secondResult.prior_units, 6);
      assert.equal(secondResult.aggregate_units, 11);
    } finally {
      releaseFirst();
      firstClient.release();
      secondClient.release();
    }
  } finally {
    await adminPool.query("DELETE FROM ai_pending_actions WHERE org_id = $1::uuid", [tenant.orgId]);
    await adminPool.query("DELETE FROM customer_privacy_hmac_keys WHERE org_id = $1::uuid", [
      tenant.orgId,
    ]);
    await adminPool.query("DELETE FROM staffs WHERE org_id = $1::uuid", [tenant.orgId]);
    await adminPool.query("DELETE FROM stores WHERE org_id = $1::uuid", [tenant.orgId]);
    await adminPool.query("DELETE FROM orgs WHERE id = $1::uuid", [tenant.orgId]);
    await appPool.end();
    await adminPool.end();
  }
});

maybe("real PG caps rolling pending cards per store without sharing capacity", async () => {
  assert.ok(urls);
  const adminPool = createPgPool({ connectionString: urls.admin });
  const appPool = createPgPool({ connectionString: urls.app, max: 2 });
  const tenant = await seed(adminPool);
  const otherStoreId = randomUUID();
  try {
    await adminPool.query(
      `INSERT INTO stores (id, org_id, code, name, timezone, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, 'Other Risk Store', 'UTC', now(), now())`,
      [otherStoreId, tenant.orgId, `notify-risk-other-${tenant.orgId.slice(0, 8)}`],
    );
    await withPoolClient(appPool, (client) =>
      withTenantTransaction(client, tenant, async (tx) => {
        const store = createPgPendingActionStore(appPool);
        for (let index = 0; index < NOTIFICATION_ROLLING_PENDING_LIMIT; index += 1) {
          await store.measureRiskReservation(riskRequest(1), { tenant, client: tx });
          await store.create(card(tenant, 1, randomUUID()), { tenant, client: tx });
        }
        await assert.rejects(
          async () => await store.measureRiskReservation(riskRequest(1), { tenant, client: tx }),
          PendingRiskCapacityExceededError,
        );
        await tx.query(
          `UPDATE ai_pending_actions SET status = 'expired'
            WHERE org_id = $1::uuid AND store_id = $2::uuid
              AND command = 'notification.delivery_batch.enqueue'`,
          [tenant.orgId, tenant.storeId],
        );
        await assert.rejects(
          async () => await store.measureRiskReservation(riskRequest(1), { tenant, client: tx }),
          PendingRiskCapacityExceededError,
        );
      }),
    );

    const otherTenant = Object.freeze({ ...tenant, storeId: otherStoreId });
    const other = await withPoolClient(appPool, (client) =>
      withTenantTransaction(
        client,
        otherTenant,
        async (tx) =>
          await createPgPendingActionStore(appPool).measureRiskReservation(riskRequest(1), {
            tenant: otherTenant,
            client: tx,
          }),
      ),
    );
    assert.equal(other.prior_units, 0);
    assert.equal(other.aggregate_units, 1);
  } finally {
    await adminPool.query("DELETE FROM ai_pending_actions WHERE org_id = $1::uuid", [tenant.orgId]);
    await adminPool.query("DELETE FROM customer_privacy_hmac_keys WHERE org_id = $1::uuid", [
      tenant.orgId,
    ]);
    await adminPool.query("DELETE FROM staffs WHERE org_id = $1::uuid", [tenant.orgId]);
    await adminPool.query("DELETE FROM stores WHERE org_id = $1::uuid", [tenant.orgId]);
    await adminPool.query("DELETE FROM orgs WHERE id = $1::uuid", [tenant.orgId]);
    await appPool.end();
    await adminPool.end();
  }
});
