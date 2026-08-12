import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { ActorContext } from "../bus/types.js";
import { createPgPool, resolvePgUrls, type PgPool } from "../db/pg-pool.js";
import { withPoolClient } from "../db/pg-sql-client.js";
import { withTenantTransaction } from "../db/tenant-transaction.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { createRegisteredM1Bus } from "../handlers/register-m1.js";
import { createPgMemberStore } from "../member/pg-store.js";
import { createPgMemberDeps } from "../member/runtime.js";
import { createPgOrderStore } from "../order/pg-order-store.js";
import { createPgShiftStore } from "../shift/pg-shift-store.js";
import { createPgStatsQuery } from "../stats/pg-source.js";
import { acquirePgBusinessDayLock } from "../workday/business-day-lock.js";
import {
  confirmedOrderCancel,
  confirmedPgCommand,
  executePgCommand,
  waitForBackendLock,
} from "./pg-member-benefits-test-support.js";
import { createPgMemberBenefitsDeps } from "./runtime.js";
import { createPgMemberBenefitsStore } from "./pg-store.js";
import type { MemberBenefitsStore } from "./types.js";

const urls =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true"
    ? resolvePgUrls(process.env)
    : null;
const maybe = urls === null ? test.skip : test;

const DAY = "2026-08-11";
const FIXED_DATE = new Date("2026-08-11T08:00:00.000Z");
const FIXED_AT = Math.floor(FIXED_DATE.getTime() / 1_000);

type Fixture = Readonly<{
  tenant: TenantContext;
  actor: ActorContext;
  adminPool: PgPool;
  appPool: PgPool;
}>;

async function createFixture(): Promise<Fixture> {
  assert.ok(urls);
  const adminPool = createPgPool({ connectionString: urls.admin });
  const appPool = createPgPool({ connectionString: urls.app, max: 6 });
  const tenant = Object.freeze({
    orgId: randomUUID(),
    storeId: randomUUID(),
    staffId: randomUUID(),
  });
  const suffix = tenant.orgId.replaceAll("-", "").slice(0, 12);
  await adminPool.query(
    `INSERT INTO orgs (id, code, name, created_at, updated_at)
     VALUES ($1::uuid, $2, 'ADR-41 PG fixture', now(), now())`,
    [tenant.orgId, `benefits-${suffix}`],
  );
  await adminPool.query(
    `INSERT INTO stores (id, org_id, code, name, timezone, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, 'main', 'ADR-41 Store', 'UTC', now(), now())`,
    [tenant.storeId, tenant.orgId],
  );
  await adminPool.query(
    `INSERT INTO staffs (
       id, org_id, username, password_hash, display_name, is_active,
       permission_version, created_at, updated_at
     ) VALUES ($1::uuid, $2::uuid, 'admin', 'test-only', 'ADR-41 Admin', true, 1, now(), now())`,
    [tenant.staffId, tenant.orgId],
  );
  return Object.freeze({
    tenant,
    actor: Object.freeze({
      staffId: tenant.staffId,
      deviceId: randomUUID(),
      via: "ui" as const,
      permissions: Object.freeze([
        "customer_read",
        "order_write",
        "member_rule_write",
        "member_lifecycle_manage",
        "shift_close",
      ]),
    }),
    adminPool,
    appPool,
  });
}

async function cleanupFixture(fixture: Fixture): Promise<void> {
  await fixture.appPool.end();
  const client = await fixture.adminPool.connect();
  try {
    await client.query("BEGIN");
    for (const table of [
      "customer_erasure_tombstones",
      "customer_addresses",
      "customer_identifiers",
      "customer_profiles",
      "coupon_redemption_reversals",
      "coupon_redemptions",
      "coupon_grants",
      "punch_card_ledger",
      "punch_cards",
      "points_allocations",
      "points_ledger",
      "member_memberships",
      "coupons",
      "member_punch_types",
      "member_points_policies",
      "member_tiers",
      "member_ledger",
      "member_accounts",
      "shift_closings",
      "audit_log",
      "orders",
      "customers",
      "staffs",
      "stores",
    ]) {
      await client.query(`DELETE FROM ${table} WHERE org_id = $1::uuid`, [fixture.tenant.orgId]);
    }
    await client.query("DELETE FROM customer_privacy_hmac_keys WHERE org_id = $1::uuid", [
      fixture.tenant.orgId,
    ]);
    await client.query("DELETE FROM orgs WHERE id = $1::uuid", [fixture.tenant.orgId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await fixture.adminPool.end();
  }
}

async function withBenefits<T>(
  fixture: Fixture,
  run: (store: MemberBenefitsStore, client: SqlClient) => Promise<T>,
  newId?: () => string,
): Promise<T> {
  return withPoolClient(fixture.appPool, (client) =>
    withTenantTransaction(client, fixture.tenant, (tx) =>
      run(
        createPgMemberBenefitsStore(tx, fixture.tenant, newId === undefined ? {} : { newId }),
        tx,
      ),
    ),
  );
}

async function createAccount(
  fixture: Fixture,
): Promise<Readonly<{ accountId: string; customerId: string }>> {
  const customerId = randomUUID();
  return withPoolClient(fixture.appPool, (client) =>
    withTenantTransaction(client, fixture.tenant, async (tx) => {
      await tx.query(
        `INSERT INTO customers (id, org_id, phone, created_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3, now(), now())`,
        [customerId, fixture.tenant.orgId, `139${customerId.replaceAll("-", "").slice(0, 8)}`],
      );
      const opened = await createPgMemberStore(tx, fixture.tenant).openAccount({
        customer_id: customerId,
        store_id: fixture.tenant.storeId,
        at: FIXED_AT,
      });
      assert.equal(opened.ok, true);
      if (!opened.ok) throw new Error("member account open refused");
      return Object.freeze({ accountId: opened.value.account.account_id, customerId });
    }),
  );
}

async function createOrder(
  fixture: Fixture,
  customerId: string,
  status: "open" | "closed",
  paidCents: number,
): Promise<string> {
  const orderId = randomUUID();
  await withPoolClient(fixture.appPool, (client) =>
    withTenantTransaction(client, fixture.tenant, async (tx) => {
      await tx.query(
        `INSERT INTO orders (
           id, org_id, store_id, ticket_no, status, customer_id,
           subtotal_cents, original_cents, discount_cents,
           addon_cents, urgent_cents, freight_cents,
           payable_cents, paid_cents, balance_cents,
           created_at, updated_at, created_by_staff_id, business_date
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid,
           3000, 3000, 0, 0, 0, 0, 3000, $7, 3000 - $7,
           to_timestamp($8), to_timestamp($8), $9::uuid, $10
         )`,
        [
          orderId,
          fixture.tenant.orgId,
          fixture.tenant.storeId,
          `B-${orderId.slice(0, 8)}`,
          status,
          customerId,
          paidCents,
          FIXED_AT,
          fixture.tenant.staffId,
          DAY,
        ],
      );
    }),
  );
  return orderId;
}

async function createDefinition(
  fixture: Fixture,
  definition: Parameters<MemberBenefitsStore["upsertDefinition"]>[0]["definition"],
) {
  return withBenefits(fixture, (store) =>
    store.upsertDefinition({ definition, staff_id: fixture.tenant.staffId, at: FIXED_AT }),
  );
}

maybe("ADR-41 PostgreSQL CAS, FIFO points and concurrent punch use are real", async () => {
  const fixture = await createFixture();
  try {
    const account = await createAccount(fixture);
    const tier = await createDefinition(fixture, {
      kind: "tier",
      expected_version: 0,
      code: "gold",
      name: "金卡",
      level: 3,
      discount_bps: 500,
      status: "active",
    });
    assert.equal(tier.ok, true);
    if (!tier.ok || tier.value.definition.kind !== "tier") return;
    const tierId = tier.value.definition.definition_id;
    assert.deepEqual(
      await createDefinition(fixture, {
        kind: "tier",
        definition_id: tierId,
        expected_version: 0,
        code: "gold",
        name: "陈旧页面",
        level: 2,
        discount_bps: 250,
        status: "active",
      }),
      { ok: false, reason: "definition_version_conflict" },
    );

    const membership = await withBenefits(fixture, (store) =>
      store.setMembership({
        account_id: account.accountId,
        expected_version: 0,
        tier_id: tierId,
        valid_until: "2026-09-11",
        reason: "升级",
        store_id: fixture.tenant.storeId,
        staff_id: fixture.tenant.staffId,
        at: FIXED_AT,
        business_date: DAY,
      }),
    );
    assert.equal(membership.ok && membership.value.benefits.membership.version, 1);

    const firstPolicy = await createDefinition(fixture, {
      kind: "points_policy",
      expected_version: 0,
      unit_cents: 100,
      points_per_unit: 1,
      valid_days: 10,
      status: "active",
    });
    assert.equal(firstPolicy.ok, true);
    const firstOrder = await createOrder(fixture, account.customerId, "closed", 3_000);
    const firstEarn = await withBenefits(fixture, (store) =>
      store.earnPoints({
        account_id: account.accountId,
        order_id: firstOrder,
        store_id: fixture.tenant.storeId,
        staff_id: fixture.tenant.staffId,
        at: FIXED_AT,
        business_date: DAY,
      }),
    );
    assert.equal(firstEarn.ok && firstEarn.value.benefits.points.available_points, 30);
    const replay = await withBenefits(fixture, (store) =>
      store.earnPoints({
        account_id: account.accountId,
        order_id: firstOrder,
        store_id: fixture.tenant.storeId,
        staff_id: fixture.tenant.staffId,
        at: FIXED_AT,
        business_date: DAY,
      }),
    );
    assert.equal(replay.ok && replay.value.changed, false);

    const updatedPolicy = await createDefinition(fixture, {
      kind: "points_policy",
      expected_version: 1,
      unit_cents: 100,
      points_per_unit: 1,
      valid_days: 30,
      status: "active",
    });
    assert.equal(updatedPolicy.ok, true);
    const secondOrder = await createOrder(fixture, account.customerId, "closed", 3_000);
    await withBenefits(fixture, (store) =>
      store.earnPoints({
        account_id: account.accountId,
        order_id: secondOrder,
        store_id: fixture.tenant.storeId,
        staff_id: fixture.tenant.staffId,
        at: FIXED_AT + 1,
        business_date: DAY,
      }),
    );
    const redeemed = await withBenefits(fixture, (store) =>
      store.redeemPoints({
        account_id: account.accountId,
        points: 35,
        reason: "兑换",
        store_id: fixture.tenant.storeId,
        staff_id: fixture.tenant.staffId,
        at: FIXED_AT + 2,
        business_date: DAY,
      }),
    );
    assert.equal(redeemed.ok && redeemed.value.benefits.points.available_points, 25);
    if (!redeemed.ok) return;
    const allocations = await fixture.adminPool.query<
      Readonly<{ order_id: string; points: number }>
    >(
      `SELECT earn.order_id::text, allocation.points
         FROM points_allocations allocation
         JOIN points_ledger earn ON earn.org_id = allocation.org_id
          AND earn.id = allocation.earn_ledger_id
        WHERE allocation.org_id = $1::uuid AND allocation.redeem_ledger_id = $2::uuid
        ORDER BY earn.expires_on ASC`,
      [fixture.tenant.orgId, redeemed.value.entity_id],
    );
    assert.deepEqual(allocations.rows, [
      { order_id: firstOrder, points: 30 },
      { order_id: secondOrder, points: 5 },
    ]);

    const punchType = await createDefinition(fixture, {
      kind: "punch_type",
      expected_version: 0,
      code: "wash10",
      name: "十次卡",
      total_uses: 10,
      valid_days: 30,
      status: "active",
    });
    assert.equal(punchType.ok, true);
    if (!punchType.ok || punchType.value.definition.kind !== "punch_type") return;
    const punchTypeId = punchType.value.definition.definition_id;
    const grant = await withBenefits(fixture, (store) =>
      store.grantAsset({
        asset_kind: "punch",
        account_id: account.accountId,
        definition_id: punchTypeId,
        reason: "购卡",
        store_id: fixture.tenant.storeId,
        staff_id: fixture.tenant.staffId,
        at: FIXED_AT,
        business_date: DAY,
      }),
    );
    assert.equal(grant.ok, true);
    if (!grant.ok) return;
    const assetId = grant.value.benefits.punch_cards[0]?.asset_id;
    assert.ok(assetId);
    const consume = () =>
      withBenefits(fixture, (store) =>
        store.consumePunch({
          asset_id: assetId,
          uses: 7,
          reason: "并发验收",
          store_id: fixture.tenant.storeId,
          staff_id: fixture.tenant.staffId,
          at: FIXED_AT + 3,
          business_date: DAY,
        }),
      );
    const outcomes = await Promise.all([consume(), consume()]);
    assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1);
    assert.deepEqual(
      outcomes.find((outcome) => !outcome.ok),
      {
        ok: false,
        reason: "insufficient_uses",
      },
    );

    const wrongTenant = Object.freeze({ ...fixture.tenant, orgId: randomUUID() });
    const hidden = await withPoolClient(fixture.appPool, (client) =>
      withTenantTransaction(client, wrongTenant, (tx) =>
        tx.query<{ count: string }>("SELECT count(*)::text AS count FROM member_tiers"),
      ),
    );
    assert.equal(hidden.rows[0]?.count, "0");
    await assert.rejects(
      () =>
        withPoolClient(fixture.appPool, (client) =>
          withTenantTransaction(client, fixture.tenant, (tx) =>
            tx.query("UPDATE points_ledger SET points_delta = 999 WHERE org_id = $1::uuid", [
              fixture.tenant.orgId,
            ]),
          ),
        ),
      /permission denied/iu,
    );
  } finally {
    await cleanupFixture(fixture);
  }
});

maybe("coupon, order and audit share one PostgreSQL transaction", async () => {
  const fixture = await createFixture();
  const triggerSuffix = randomUUID().replaceAll("-", "");
  const triggerName = `benefit_audit_failure_${triggerSuffix}`;
  const functionName = `fail_benefit_audit_${triggerSuffix}`;
  const cancellationFailureKey = randomUUID();
  try {
    const account = await createAccount(fixture);
    const couponType = await createDefinition(fixture, {
      kind: "coupon_type",
      expected_version: 0,
      code: "welcome",
      name: "迎新券",
      discount_cents: 500,
      min_order_cents: 1_000,
      valid_days: 30,
      status: "active",
    });
    assert.equal(couponType.ok, true);
    if (!couponType.ok || couponType.value.definition.kind !== "coupon_type") return;
    const couponTypeId = couponType.value.definition.definition_id;
    const grant = await withBenefits(fixture, (store) =>
      store.grantAsset({
        asset_kind: "coupon",
        account_id: account.accountId,
        definition_id: couponTypeId,
        reason: "迎新",
        store_id: fixture.tenant.storeId,
        staff_id: fixture.tenant.staffId,
        at: FIXED_AT,
        business_date: DAY,
      }),
    );
    assert.equal(grant.ok, true);
    if (!grant.ok) return;
    const assetId = grant.value.benefits.coupons[0]?.asset_id;
    assert.ok(assetId);
    const orderId = await createOrder(fixture, account.customerId, "open", 0);
    const idempotencyKey = randomUUID();
    await fixture.adminPool.query(
      `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF (NEW.command = 'member.asset.consume' AND NEW.idempotency_key = '${idempotencyKey}')
            OR (NEW.command = 'order.cancel' AND NEW.idempotency_key = '${cancellationFailureKey}') THEN
           RAISE EXCEPTION 'forced ADR-41 audit failure';
         END IF;
         RETURN NEW;
       END $$`,
    );
    await fixture.adminPool.query(
      `CREATE TRIGGER ${triggerName} BEFORE INSERT ON audit_log
       FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
    );

    const orderStore = createPgOrderStore(fixture.appPool);
    const shiftStore = createPgShiftStore(fixture.appPool, {
      orgId: fixture.tenant.orgId,
      storeId: fixture.tenant.storeId,
    });
    const bus = createRegisteredM1Bus({
      order: Object.freeze({
        store: orderStore,
        now: () => FIXED_AT,
        timeZone: "UTC",
        rolloverHour: 0,
        lockBusinessDay: acquirePgBusinessDayLock,
        isBusinessDayClosed: async (businessDate) =>
          (await shiftStore.getByBusinessDate(
            fixture.tenant.orgId,
            fixture.tenant.storeId,
            businessDate,
          )) !== null,
      }),
      shift: Object.freeze({
        store: shiftStore,
        stats: createPgStatsQuery(fixture.appPool),
        now: () => FIXED_AT,
        timeZone: "UTC",
        rolloverHour: 0,
        lockBusinessDay: acquirePgBusinessDayLock,
      }),
      memberBenefits: createPgMemberBenefitsDeps({
        orgId: fixture.tenant.orgId,
        memberStore: createPgMemberDeps().store,
        orderStore,
      }),
    });
    const issue = (targetAssetId: string, targetOrderId: string, key: string) =>
      executePgCommand(
        fixture,
        bus,
        "member.asset.consume",
        { asset: { asset_kind: "coupon", asset_id: targetAssetId, order_id: targetOrderId } },
        { idempotencyKey: key },
      );

    const failed = await issue(assetId, orderId, idempotencyKey);
    assert.equal(failed.ok, false);
    if (!failed.ok) assert.equal(failed.error.code, "TRANSACTION_FAILED");
    const rolledBack = await fixture.adminPool.query<
      Readonly<{ discount_cents: number; redemptions: string }>
    >(
      `SELECT orders.discount_cents,
              (SELECT count(*)::text FROM coupon_redemptions
                WHERE org_id = $1::uuid AND grant_id = $2::uuid) AS redemptions
         FROM orders WHERE org_id = $1::uuid AND id = $3::uuid`,
      [fixture.tenant.orgId, assetId, orderId],
    );
    assert.deepEqual(rolledBack.rows[0], { discount_cents: 0, redemptions: "0" });

    const successKey = randomUUID();
    const succeeded = await issue(assetId, orderId, successKey);
    assert.equal(succeeded.ok, true, JSON.stringify(succeeded));
    const committed = await fixture.adminPool.query<
      Readonly<{ discount_cents: number; payable_cents: number; audits: string }>
    >(
      `SELECT orders.discount_cents, orders.payable_cents,
              (SELECT count(*)::text FROM audit_log
                WHERE org_id = $1::uuid AND idempotency_key = $2) AS audits
         FROM orders WHERE org_id = $1::uuid AND id = $3::uuid`,
      [fixture.tenant.orgId, successKey, orderId],
    );
    assert.deepEqual(committed.rows[0], { discount_cents: 500, payable_cents: 2_500, audits: "1" });

    const failedCancellation = await confirmedOrderCancel(
      fixture,
      bus,
      orderId,
      cancellationFailureKey,
    );
    assert.equal(failedCancellation.ok, false, JSON.stringify(failedCancellation));
    if (!failedCancellation.ok) {
      assert.equal(failedCancellation.error.code, "TRANSACTION_FAILED");
    }
    const cancellationRollback = await fixture.adminPool.query<
      Readonly<{ status: string; reversals: string; active_redemptions: string }>
    >(
      `SELECT orders.status,
              (SELECT count(*)::text FROM coupon_redemption_reversals
                WHERE org_id = $1::uuid AND order_id = $2::uuid) AS reversals,
              (SELECT count(*)::text
                 FROM coupon_redemptions redemption
                 LEFT JOIN coupon_redemption_reversals reversal
                   ON reversal.org_id = redemption.org_id
                  AND reversal.redemption_id = redemption.id
                WHERE redemption.org_id = $1::uuid AND redemption.grant_id = $3::uuid
                  AND reversal.id IS NULL) AS active_redemptions
         FROM orders WHERE org_id = $1::uuid AND id = $2::uuid`,
      [fixture.tenant.orgId, orderId, assetId],
    );
    assert.deepEqual(cancellationRollback.rows[0], {
      status: "open",
      reversals: "0",
      active_redemptions: "1",
    });

    await fixture.adminPool.query(`DROP TRIGGER ${triggerName} ON audit_log`);
    await fixture.adminPool.query(`DROP FUNCTION ${functionName}()`);
    const cancellationKey = randomUUID();
    const cancelled = await confirmedOrderCancel(fixture, bus, orderId, cancellationKey);
    assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
    const returned = await withBenefits(fixture, (store) =>
      store.getBenefits({
        customer_id: account.customerId,
        include_expired: true,
        business_date: DAY,
      }),
    );
    assert.equal(returned.ok && returned.value.coupons[0]?.status, "active");
    if (!returned.ok) return;
    assert.equal(returned.value.coupons[0]?.redeemed_order_id, null);

    const reusedOrderId = await createOrder(fixture, account.customerId, "open", 0);
    const reused = await issue(assetId, reusedOrderId, randomUUID());
    assert.equal(reused.ok, true, JSON.stringify(reused));
    const history = await fixture.adminPool.query<
      Readonly<{ redemptions: string; reversals: string; active_redemptions: string }>
    >(
      `SELECT
         (SELECT count(*)::text FROM coupon_redemptions
           WHERE org_id = $1::uuid AND grant_id = $2::uuid) AS redemptions,
         (SELECT count(*)::text FROM coupon_redemption_reversals
           WHERE org_id = $1::uuid AND grant_id = $2::uuid) AS reversals,
         (SELECT count(*)::text
            FROM coupon_redemptions redemption
            LEFT JOIN coupon_redemption_reversals reversal
              ON reversal.org_id = redemption.org_id
             AND reversal.redemption_id = redemption.id
           WHERE redemption.org_id = $1::uuid AND redemption.grant_id = $2::uuid
             AND reversal.id IS NULL) AS active_redemptions`,
      [fixture.tenant.orgId, assetId],
    );
    assert.deepEqual(history.rows[0], {
      redemptions: "2",
      reversals: "1",
      active_redemptions: "1",
    });

    const closedDayGrant = await withBenefits(fixture, (store) =>
      store.grantAsset({
        asset_kind: "coupon",
        account_id: account.accountId,
        definition_id: couponTypeId,
        reason: "日结前发券",
        store_id: fixture.tenant.storeId,
        staff_id: fixture.tenant.staffId,
        at: FIXED_AT,
        business_date: DAY,
      }),
    );
    assert.equal(closedDayGrant.ok, true);
    if (!closedDayGrant.ok) return;
    const closedDayAssetId = closedDayGrant.value.entity_id;
    const closedDayOrderId = await createOrder(fixture, account.customerId, "open", 0);
    const closed = await confirmedPgCommand(
      fixture,
      bus,
      "shift.close",
      {
        business_date: DAY,
        counted_cash_cents: 0,
        retained_float_cents: 0,
        signature_name: "ADR-41 Admin",
      },
      randomUUID(),
    );
    assert.equal(closed.ok, true, JSON.stringify(closed));
    const blockedAfterClose = await issue(closedDayAssetId, closedDayOrderId, randomUUID());
    assert.equal(blockedAfterClose.ok, false, JSON.stringify(blockedAfterClose));
    if (!blockedAfterClose.ok) assert.equal(blockedAfterClose.error.code, "SHIFT_CLOSED");
    const closedDayState = await fixture.adminPool.query<
      Readonly<{ discount_cents: number; redemptions: string }>
    >(
      `SELECT orders.discount_cents,
              (SELECT count(*)::text FROM coupon_redemptions
                WHERE org_id = $1::uuid AND grant_id = $2::uuid) AS redemptions
         FROM orders WHERE org_id = $1::uuid AND id = $3::uuid`,
      [fixture.tenant.orgId, closedDayAssetId, closedDayOrderId],
    );
    assert.deepEqual(closedDayState.rows[0], { discount_cents: 0, redemptions: "0" });
  } finally {
    await fixture.adminPool.query(`DROP TRIGGER IF EXISTS ${triggerName} ON audit_log`);
    await fixture.adminPool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
    await cleanupFixture(fixture);
  }
});

maybe("asset grant waits for a concurrent definition retirement", async () => {
  const fixture = await createFixture();
  const adminClient = await fixture.adminPool.connect();
  const appClient = await fixture.appPool.connect();
  let adminTransactionOpen = false;
  try {
    const account = await createAccount(fixture);
    const couponType = await createDefinition(fixture, {
      kind: "coupon_type",
      expected_version: 0,
      code: "retiring",
      name: "即将停用",
      discount_cents: 300,
      min_order_cents: 1_000,
      valid_days: 30,
      status: "active",
    });
    assert.equal(couponType.ok, true);
    if (!couponType.ok || couponType.value.definition.kind !== "coupon_type") return;
    const definitionId = couponType.value.definition.definition_id;
    const pidResult = await appClient.query<Readonly<{ pid: number }>>(
      "SELECT pg_backend_pid() AS pid",
    );
    const backendPid = pidResult.rows[0]?.pid;
    assert.ok(backendPid);

    await adminClient.query("BEGIN");
    adminTransactionOpen = true;
    await adminClient.query(
      `UPDATE coupons SET status = 'retired'
        WHERE org_id = $1::uuid AND id = $2::uuid`,
      [fixture.tenant.orgId, definitionId],
    );
    const grantPromise = withTenantTransaction(appClient, fixture.tenant, (tx) =>
      createPgMemberBenefitsStore(tx, fixture.tenant).grantAsset({
        asset_kind: "coupon",
        account_id: account.accountId,
        definition_id: definitionId,
        reason: "并发发放",
        store_id: fixture.tenant.storeId,
        staff_id: fixture.tenant.staffId,
        at: FIXED_AT,
        business_date: DAY,
      }),
    );
    try {
      await waitForBackendLock(fixture, backendPid);
      await adminClient.query("COMMIT");
      adminTransactionOpen = false;
      assert.deepEqual(await grantPromise, { ok: false, reason: "definition_retired" });
    } finally {
      if (adminTransactionOpen) {
        await adminClient.query("ROLLBACK");
        adminTransactionOpen = false;
      }
      await grantPromise.catch(() => undefined);
    }
    const grants = await fixture.adminPool.query<Readonly<{ count: string }>>(
      `SELECT count(*)::text AS count FROM coupon_grants
        WHERE org_id = $1::uuid AND definition_id = $2::uuid`,
      [fixture.tenant.orgId, definitionId],
    );
    assert.equal(grants.rows[0]?.count, "0");
  } finally {
    if (adminTransactionOpen) await adminClient.query("ROLLBACK");
    appClient.release();
    adminClient.release();
    await cleanupFixture(fixture);
  }
});
