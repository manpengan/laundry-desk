import assert from "node:assert/strict";
import test from "node:test";

import { createPgPool, resolvePgUrls, type PgPoolClient } from "../db/pg-pool.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { LOCAL_PROFILE } from "../local/profile.js";
import { audienceDigest } from "./audience.js";
import { couponIssueConfirmationSummary } from "./coupon-authority.js";
import { createPgMarketingStore } from "./pg-store.js";

const enabled =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true";
const urls = enabled ? resolvePgUrls(process.env) : null;

const IDS = Object.freeze({
  customerA: "81000000-0000-4000-8000-000000000001",
  customerB: "81000000-0000-4000-8000-000000000002",
  accountA: "82000000-0000-4000-8000-000000000001",
  accountB: "82000000-0000-4000-8000-000000000002",
  coupon: "83000000-0000-4000-8000-000000000001",
  couponB: "83000000-0000-4000-8000-000000000002",
  campaign: "84000000-0000-4000-8000-000000000001",
  snapshot: "85000000-0000-4000-8000-000000000001",
  grantA: "86000000-0000-4000-8000-000000000001",
  grantB: "86000000-0000-4000-8000-000000000002",
  batch: "87000000-0000-4000-8000-000000000001",
  mappingA: "88000000-0000-4000-8000-000000000001",
  mappingB: "88000000-0000-4000-8000-000000000002",
  budget: "89000000-0000-4000-8000-000000000001",
});
const TENANT: TenantContext = Object.freeze({
  orgId: LOCAL_PROFILE.orgId,
  storeId: LOCAL_PROFILE.storeId,
  staffId: LOCAL_PROFILE.adminStaffId,
});

async function seedTenant(client: PgPoolClient): Promise<void> {
  const now = new Date();
  await client.query(
    `INSERT INTO orgs (id, code, name, created_at, updated_at)
     VALUES ($1,'item8_pg','Item 8 PG',$2,$2)
     ON CONFLICT DO NOTHING`,
    [LOCAL_PROFILE.orgId, now],
  );
  await client.query(
    `INSERT INTO stores (id, org_id, code, name, timezone, created_at, updated_at)
     VALUES ($1,$2,'main','Item 8 PG','Asia/Taipei',$3,$3)
     ON CONFLICT DO NOTHING`,
    [LOCAL_PROFILE.storeId, LOCAL_PROFILE.orgId, now],
  );
  await client.query(
    `INSERT INTO staffs
     (id, org_id, username, password_hash, pin_hash, display_name,
        is_active, permission_version, created_at, updated_at)
     VALUES ($1,$2,'item8-admin','test-only-not-authenticated',NULL,'Item 8 Admin',true,1,$3,$3)
     ON CONFLICT DO NOTHING`,
    [LOCAL_PROFILE.adminStaffId, LOCAL_PROFILE.orgId, now],
  );
}

async function seedAuthority(client: PgPoolClient): Promise<string> {
  const now = new Date();
  await client.query(
    `INSERT INTO customers (id, org_id, phone, name, note, created_at, updated_at)
     VALUES ($1,$3,'19900000081','Campaign Cap A',NULL,$4,$4),
            ($2,$3,'19900000082','Campaign Cap B',NULL,$4,$4)`,
    [IDS.customerA, IDS.customerB, LOCAL_PROFILE.orgId, now],
  );
  await client.query(
    `INSERT INTO member_accounts (id, org_id, customer_id, status, opened_at, opened_store_id)
     VALUES ($1,$3,$4,'active',$7,$6), ($2,$3,$5,'active',$7,$6)`,
    [
      IDS.accountA,
      IDS.accountB,
      LOCAL_PROFILE.orgId,
      IDS.customerA,
      IDS.customerB,
      LOCAL_PROFILE.storeId,
      now,
    ],
  );
  await client.query(
    `INSERT INTO coupons
       (id, org_id, code, name, discount_cents, min_order_cents, valid_days,
        status, version, updated_at, updated_by_staff_id, note)
     VALUES ($1,$2,'campaign_cap_pg','Campaign cap PG',500,0,30,
             'active',1,$5,$3,NULL),
            ($4,$2,'campaign_cap_pg_b','Campaign cap PG B',500,0,30,
             'active',1,$5,$3,NULL)`,
    [IDS.coupon, LOCAL_PROFILE.orgId, LOCAL_PROFILE.adminStaffId, IDS.couponB, now],
  );
  await client.query(
    `INSERT INTO campaigns
       (id, org_id, store_id, code, name, status, starts_at, ends_at,
        audience_rule, audience_rule_sha256, recipient_limit, budget_limit_cents,
        version, created_by_staff_id, created_at, updated_by_staff_id, updated_at)
     VALUES ($1,$2,$3,'campaign_cap_pg','Campaign cap PG','scheduled',
             $5::timestamptz - interval '1 day', $5::timestamptz + interval '1 day',
             '{"customer_age":{"kind":"any"},"membership":{"kind":"any"},"order_activity":{"kind":"any"}}'::jsonb,
             $6,2,1000,1,$4,$5,$4,$5)`,
    [
      IDS.campaign,
      LOCAL_PROFILE.orgId,
      LOCAL_PROFILE.storeId,
      LOCAL_PROFILE.adminStaffId,
      now,
      "a".repeat(64),
    ],
  );
  const campaignAuthority = await client.query<Readonly<{ audience_rule_sha256: string }>>(
    `SELECT audience_rule_sha256 FROM campaigns
      WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid`,
    [LOCAL_PROFILE.orgId, LOCAL_PROFILE.storeId, IDS.campaign],
  );
  const ruleDigest = campaignAuthority.rows[0]?.audience_rule_sha256;
  if (ruleDigest === undefined) throw new Error("campaign rule digest unavailable");
  const frozenAudienceDigest = audienceDigest(IDS.campaign, 1, ruleDigest, [
    IDS.customerA,
    IDS.customerB,
  ]);
  await client.query(
    `INSERT INTO campaign_audience_snapshots
       (id, org_id, store_id, campaign_id, campaign_version, audience_rule_sha256,
        audience_digest, recipient_count, created_by_staff_id, created_at)
     VALUES ($1,$2,$3,$4,1,
             (SELECT audience_rule_sha256 FROM campaigns
               WHERE org_id=$2 AND store_id=$3 AND id=$4),
             $7,2,$5,$6)`,
    [
      IDS.snapshot,
      LOCAL_PROFILE.orgId,
      LOCAL_PROFILE.storeId,
      IDS.campaign,
      LOCAL_PROFILE.adminStaffId,
      now,
      frozenAudienceDigest,
    ],
  );
  await client.query(
    `INSERT INTO coupon_grants
       (id, org_id, account_id, definition_id, code, name, discount_cents,
        min_order_cents, granted_on, expires_on, granted_at, granted_store_id,
        granted_by_staff_id, reason)
     VALUES ($1,$3,$4,$6,'campaign_cap_pg','Campaign cap PG',500,0,
             CURRENT_DATE,CURRENT_DATE + 30,$8,$7,$5,'cap test'),
            ($2,$3,$9,$6,'campaign_cap_pg','Campaign cap PG',500,0,
             CURRENT_DATE,CURRENT_DATE + 30,$8,$7,$5,'cap test')`,
    [
      IDS.grantA,
      IDS.grantB,
      LOCAL_PROFILE.orgId,
      IDS.accountA,
      LOCAL_PROFILE.adminStaffId,
      IDS.coupon,
      LOCAL_PROFILE.storeId,
      now,
      IDS.accountB,
    ],
  );
  return frozenAudienceDigest;
}

async function insertCompleteBatch(
  client: PgPoolClient,
  frozenAudienceDigest: string,
): Promise<void> {
  const now = new Date();
  await client.query(
    `INSERT INTO campaign_coupon_batches
       (id, org_id, store_id, campaign_id, campaign_version, audience_snapshot_id,
        audience_digest, coupon_definition_id, coupon_version, coupon_code, coupon_name,
        coupon_discount_cents, coupon_min_order_cents, coupon_valid_days,
        audience_recipient_count, eligible_recipient_count, granted_count,
        budget_committed_cents, reason, created_by_staff_id, created_at)
     VALUES ($1,$2,$3,$4,1,$5,$6,$7,1,'campaign_cap_pg','Campaign cap PG',
             500,0,30,2,1,1,500,'cap test',$8,$9)`,
    [
      IDS.batch,
      LOCAL_PROFILE.orgId,
      LOCAL_PROFILE.storeId,
      IDS.campaign,
      IDS.snapshot,
      frozenAudienceDigest,
      IDS.coupon,
      LOCAL_PROFILE.adminStaffId,
      now,
    ],
  );
  await client.query(
    `INSERT INTO campaign_coupon_grants
       (id, org_id, store_id, batch_id, campaign_id, audience_snapshot_id,
        coupon_grant_id, account_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      IDS.mappingA,
      LOCAL_PROFILE.orgId,
      LOCAL_PROFILE.storeId,
      IDS.batch,
      IDS.campaign,
      IDS.snapshot,
      IDS.grantA,
      IDS.accountA,
      now,
    ],
  );
  await client.query(
    `INSERT INTO campaign_budget_ledger
       (id, org_id, store_id, campaign_id, kind, source_id, amount_cents, staff_id, at)
     VALUES ($1,$2,$3,$4,'coupon_issue',$5,500,$6,$7)`,
    [
      IDS.budget,
      LOCAL_PROFILE.orgId,
      LOCAL_PROFILE.storeId,
      IDS.campaign,
      IDS.batch,
      LOCAL_PROFILE.adminStaffId,
      now,
    ],
  );
  await client.query("SET CONSTRAINTS ALL IMMEDIATE");
}

async function backendPid(client: PgPoolClient): Promise<number> {
  const result = await client.query<Readonly<{ pid: number }>>("SELECT pg_backend_pid() AS pid");
  const pid = result.rows[0]?.pid;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid)) {
    throw new Error("PostgreSQL backend PID unavailable");
  }
  return pid;
}

async function waitForDatabaseLock(
  pool: ReturnType<typeof createPgPool>,
  pid: number,
  blockerPid: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const activity = await pool.query<
      Readonly<{ wait_event_type: string | null; blocker_pids: readonly number[] }>
    >(
      `SELECT wait_event_type, pg_catalog.pg_blocking_pids(pid) AS blocker_pids
         FROM pg_catalog.pg_stat_activity WHERE pid=$1`,
      [pid],
    );
    const row = activity.rows[0];
    if (row?.wait_event_type === "Lock" && row.blocker_pids.includes(blockerPid)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for the campaign authority lock");
}

async function cleanupConcurrencyFixture(client: PgPoolClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query("DELETE FROM campaign_coupon_grants WHERE campaign_id=$1::uuid", [
      IDS.campaign,
    ]);
    await client.query("DELETE FROM campaign_budget_ledger WHERE campaign_id=$1::uuid", [
      IDS.campaign,
    ]);
    await client.query("DELETE FROM campaign_coupon_batches WHERE campaign_id=$1::uuid", [
      IDS.campaign,
    ]);
    await client.query("DELETE FROM coupon_grants WHERE definition_id=ANY($1::uuid[])", [
      [IDS.coupon, IDS.couponB],
    ]);
    await client.query("DELETE FROM campaign_audience_snapshots WHERE campaign_id=$1::uuid", [
      IDS.campaign,
    ]);
    await client.query("DELETE FROM campaigns WHERE id=$1::uuid", [IDS.campaign]);
    await client.query("DELETE FROM coupons WHERE id=ANY($1::uuid[])", [[IDS.coupon, IDS.couponB]]);
    await client.query("DELETE FROM member_accounts WHERE id=ANY($1::uuid[])", [
      [IDS.accountA, IDS.accountB],
    ]);
    await client.query("DELETE FROM customers WHERE id=ANY($1::uuid[])", [
      [IDS.customerA, IDS.customerB],
    ]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

test(
  "real PG locks a completed campaign coupon batch and rejects appended provenance",
  { skip: urls === null },
  async () => {
    assert.ok(urls);
    const pool = createPgPool({ connectionString: urls.admin });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE laundry_owner");
      await client.query("SET CONSTRAINTS ALL DEFERRED");
      await seedTenant(client);
      const frozenAudienceDigest = await seedAuthority(client);
      await insertCompleteBatch(client, frozenAudienceDigest);
      await client.query("SAVEPOINT append_provenance");
      await assert.rejects(
        () =>
          client.query(
            `INSERT INTO campaign_coupon_grants
               (id, org_id, store_id, batch_id, campaign_id, audience_snapshot_id,
                coupon_grant_id, account_id, created_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,statement_timestamp())`,
            [
              IDS.mappingB,
              LOCAL_PROFILE.orgId,
              LOCAL_PROFILE.storeId,
              IDS.batch,
              IDS.campaign,
              IDS.snapshot,
              IDS.grantB,
              IDS.accountB,
            ],
          ),
        /MARKETING_COUPON_BATCH_GRANT_CAP/u,
      );
      await client.query("ROLLBACK TO SAVEPOINT append_provenance");
      const count = await client.query<{ value: string }>(
        "SELECT count(*)::text AS value FROM campaign_coupon_grants WHERE batch_id=$1::uuid",
        [IDS.batch],
      );
      assert.equal(count.rows[0]?.value, "1");
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
      await pool.end();
    }
  },
);

test(
  "real PG second-hop waits for the campaign lock and rejects freshly committed budget drift",
  { skip: urls === null, timeout: 20_000 },
  async () => {
    assert.ok(urls);
    const pool = createPgPool({ connectionString: urls.admin, max: 4 });
    const setup = await pool.connect();
    const first = await pool.connect();
    const second = await pool.connect();
    const store = createPgMarketingStore();
    const at = new Date();
    const firstInput = Object.freeze({
      campaign_id: IDS.campaign,
      expected_version: 1,
      snapshot_id: IDS.snapshot,
      coupon_definition_id: IDS.coupon,
      reason: "first serialized issue",
    });
    const secondInput = Object.freeze({
      ...firstInput,
      coupon_definition_id: IDS.couponB,
      reason: "second serialized issue",
    });
    let setupOpen = false;
    let firstOpen = false;
    let secondOpen = false;
    try {
      await cleanupConcurrencyFixture(setup);
      await setup.query("BEGIN");
      setupOpen = true;
      await setup.query("SET LOCAL ROLE laundry_owner");
      await seedTenant(setup);
      const frozenAudienceDigest = await seedAuthority(setup);
      const audience = await store.previewAudience(
        setup as unknown as SqlClient,
        TENANT,
        IDS.campaign,
        1,
        at,
      );
      assert.equal(audience?.audienceDigest, frozenAudienceDigest, JSON.stringify(audience));
      const firstPreview = await store.previewCouponIssue(setup as unknown as SqlClient, TENANT, {
        ...firstInput,
        at,
      });
      const secondPreview = await store.previewCouponIssue(setup as unknown as SqlClient, TENANT, {
        ...secondInput,
        at,
      });
      assert.equal(firstPreview.ok, true, JSON.stringify(firstPreview));
      assert.equal(secondPreview.ok, true, JSON.stringify(secondPreview));
      if (!firstPreview.ok || !secondPreview.ok) throw new Error("coupon authority unavailable");
      const frozenFirst = couponIssueConfirmationSummary(firstInput, firstPreview.preview);
      const frozenSecond = couponIssueConfirmationSummary(secondInput, secondPreview.preview);
      assert.equal(frozenFirst.budget_remaining_cents, 1_000);
      assert.equal(frozenSecond.budget_remaining_cents, 1_000);
      await setup.query("COMMIT");
      setupOpen = false;

      await first.query("BEGIN");
      firstOpen = true;
      await first.query("SET LOCAL ROLE laundry_owner");
      await first.query("SET LOCAL statement_timeout = '5s'");
      const firstPid = await backendPid(first);
      const firstResult = await store.issueCoupons(first as unknown as SqlClient, TENANT, {
        ...firstInput,
        at,
        frozenAuthority: frozenFirst,
      });
      assert.equal(firstResult.ok, true, JSON.stringify(firstResult));

      await second.query("BEGIN");
      secondOpen = true;
      await second.query("SET LOCAL ROLE laundry_owner");
      await second.query("SET LOCAL statement_timeout = '5s'");
      const secondPid = await backendPid(second);
      const secondHop = store.issueCoupons(second as unknown as SqlClient, TENANT, {
        ...secondInput,
        at,
        frozenAuthority: frozenSecond,
      });
      await waitForDatabaseLock(pool, secondPid, firstPid);
      await first.query("COMMIT");
      firstOpen = false;

      const secondResult = await secondHop;
      assert.deepEqual(secondResult, { ok: false, reason: "authority_drift" });
      await second.query("ROLLBACK");
      secondOpen = false;
    } finally {
      try {
        if (setupOpen) await setup.query("ROLLBACK").catch(() => undefined);
        if (firstOpen) await first.query("ROLLBACK").catch(() => undefined);
        if (secondOpen) await second.query("ROLLBACK").catch(() => undefined);
        await cleanupConcurrencyFixture(setup);
      } finally {
        setup.release();
        first.release();
        second.release();
        await pool.end();
      }
    }
  },
);
