import assert from "node:assert/strict";
import test from "node:test";

import { createPgPool, resolvePgUrls, type PgPoolClient } from "../db/pg-pool.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import { createPgMarketingStore } from "./pg-store.js";

const enabled =
  process.env.LAUNDRY_USE_LOCAL_PG === "1" || process.env.LAUNDRY_USE_LOCAL_PG === "true";
const urls = enabled ? resolvePgUrls(process.env) : null;

const ID = Object.freeze({
  org: "91000000-0000-4000-8000-000000000001",
  store: "91000000-0000-4000-8000-000000000002",
  staff: "91000000-0000-4000-8000-000000000003",
  referrer: "91000000-0000-4000-8000-000000000004",
  referred: "91000000-0000-4000-8000-000000000005",
  referrerAccount: "91000000-0000-4000-8000-000000000006",
  referredAccount: "91000000-0000-4000-8000-000000000007",
  referralOrder: "91000000-0000-4000-8000-000000000008",
  groupOrder: "91000000-0000-4000-8000-000000000009",
  coupon: "91000000-0000-4000-8000-000000000010",
  campaign: "91000000-0000-4000-8000-000000000011",
  reward: "91000000-0000-4000-8000-000000000012",
  grant: "91000000-0000-4000-8000-000000000013",
  budget: "91000000-0000-4000-8000-000000000014",
  voucher: "91000000-0000-4000-8000-000000000015",
  redemption: "91000000-0000-4000-8000-000000000016",
});
const DIGEST = "9".repeat(64);
const TENANT: TenantContext = Object.freeze({
  orgId: ID.org,
  storeId: ID.store,
  staffId: ID.staff,
});

async function cleanup(client: PgPoolClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query("DELETE FROM group_buy_redemptions WHERE org_id=$1::uuid", [ID.org]);
    await client.query("DELETE FROM group_buy_vouchers WHERE org_id=$1::uuid", [ID.org]);
    await client.query("DELETE FROM campaign_budget_ledger WHERE org_id=$1::uuid", [ID.org]);
    await client.query("DELETE FROM referral_rewards WHERE org_id=$1::uuid", [ID.org]);
    await client.query("DELETE FROM coupon_grants WHERE org_id=$1::uuid", [ID.org]);
    await client.query("DELETE FROM orders WHERE org_id=$1::uuid", [ID.org]);
    await client.query("DELETE FROM campaigns WHERE org_id=$1::uuid", [ID.org]);
    await client.query("DELETE FROM coupons WHERE org_id=$1::uuid", [ID.org]);
    await client.query("DELETE FROM member_accounts WHERE org_id=$1::uuid", [ID.org]);
    await client.query("DELETE FROM customers WHERE org_id=$1::uuid", [ID.org]);
    await client.query("DELETE FROM staffs WHERE org_id=$1::uuid", [ID.org]);
    await client.query("DELETE FROM stores WHERE org_id=$1::uuid", [ID.org]);
    await client.query("DELETE FROM orgs WHERE id=$1::uuid", [ID.org]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function seed(client: PgPoolClient, now: Date): Promise<void> {
  await client.query(
    `INSERT INTO orgs (id, code, name, created_at, updated_at)
     VALUES ($1,'item9_pg','Item 9 PG',$2,$2)`,
    [ID.org, now],
  );
  await client.query(
    `INSERT INTO stores (id, org_id, code, name, timezone, created_at, updated_at)
     VALUES ($1,$2,'main','Item 9 PG','Asia/Taipei',$3,$3)`,
    [ID.store, ID.org, now],
  );
  await client.query(
    `INSERT INTO staffs
       (id, org_id, username, password_hash, pin_hash, display_name,
        is_active, permission_version, created_at, updated_at)
     VALUES ($1,$2,'item9-admin','test-only-not-authenticated',NULL,
             'Item 9 Admin',true,1,$3,$3)`,
    [ID.staff, ID.org, now],
  );
  await client.query(
    `INSERT INTO customers (id, org_id, phone, name, note, created_at, updated_at)
     VALUES ($1,$3,'19900000091','Referrer',NULL,$4,$4),
            ($2,$3,'19900000092','Referred',NULL,$4,$4)`,
    [ID.referrer, ID.referred, ID.org, now],
  );
  await client.query(
    `INSERT INTO member_accounts (id, org_id, customer_id, status, opened_at, opened_store_id)
     VALUES ($1,$3,$4,'active',$7,$6), ($2,$3,$5,'active',$7,$6)`,
    [ID.referrerAccount, ID.referredAccount, ID.org, ID.referrer, ID.referred, ID.store, now],
  );
  await client.query(
    `INSERT INTO coupons
       (id, org_id, code, name, discount_cents, min_order_cents, valid_days,
        status, version, updated_at, updated_by_staff_id, note)
     VALUES ($1,$2,'referral_5','Referral five',500,0,30,'active',1,$4,$3,NULL)`,
    [ID.coupon, ID.org, ID.staff, now],
  );
  await client.query(
    `INSERT INTO campaigns
       (id, org_id, store_id, code, name, status, starts_at, ends_at,
        audience_rule, audience_rule_sha256, recipient_limit, budget_limit_cents,
        version, created_by_staff_id, created_at, updated_by_staff_id, updated_at)
     VALUES ($1,$2,$3,'item9_referral','Item 9 referral','scheduled',
             $5::timestamptz - interval '1 day', $5::timestamptz + interval '1 day',
             '{"customer_age":{"kind":"any"},"membership":{"kind":"any"},"order_activity":{"kind":"any"}}'::jsonb,
             $6,10,500,1,$4,$5,$4,$5)`,
    [ID.campaign, ID.org, ID.store, ID.staff, now, "a".repeat(64)],
  );
  await client.query(
    `INSERT INTO orders
       (id, org_id, store_id, ticket_no, status, customer_phone, customer_name,
        subtotal_cents, payable_cents, paid_cents, balance_cents, created_at, updated_at,
        created_by_staff_id, original_cents, discount_cents, business_date, customer_id)
     VALUES ($1,$3,$4,'I9-REF','closed','19900000092','Referred',5000,5000,5000,0,
             $7,$7,$5,5000,0,$8,$6),
            ($2,$3,$4,'I9-GROUP','open','19900000092','Referred',8000,8000,0,8000,
             $7,$7,$5,8000,0,$8,$6)`,
    [
      ID.referralOrder,
      ID.groupOrder,
      ID.org,
      ID.store,
      ID.staff,
      ID.referred,
      now,
      now.toISOString().slice(0, 10),
    ],
  );
}

async function beginTenant(client: PgPoolClient): Promise<void> {
  await client.query("BEGIN");
  await client.query(
    `SELECT set_config('app.org_id',$1,true), set_config('app.store_id',$2,true),
            set_config('app.staff_id',$3,true)`,
    [ID.org, ID.store, ID.staff],
  );
}

test(
  "real PG commits one referral budget debit and one digest-only group-buy redemption",
  { skip: urls === null, timeout: 20_000 },
  async () => {
    assert.ok(urls);
    const adminPool = createPgPool({ connectionString: urls.admin });
    const appPool = createPgPool({ connectionString: urls.app });
    const admin = await adminPool.connect();
    const app = await appPool.connect();
    const now = new Date();
    const expiry = new Date(now);
    expiry.setUTCMonth(expiry.getUTCMonth() + 1);
    const ids = [ID.reward, ID.grant, ID.budget, ID.voucher, ID.redemption];
    const store = createPgMarketingStore({ newId: () => ids.shift()! });
    try {
      await cleanup(admin);
      await seed(admin, now);

      await beginTenant(app);
      const referralInput = Object.freeze({
        campaign_id: ID.campaign,
        expected_version: 1,
        referrer_customer_id: ID.referrer,
        referred_customer_id: ID.referred,
        qualifying_order_id: ID.referralOrder,
        coupon_definition_id: ID.coupon,
        reason: "real PG referral",
      });
      const referralPreview = await store.previewReferralReward(
        app as unknown as SqlClient,
        TENANT,
        { ...referralInput, at: now },
      );
      assert.equal(referralPreview.ok, true, JSON.stringify(referralPreview));
      if (!referralPreview.ok) throw new Error("referral authority unavailable");
      const issued = await store.issueReferralReward(app as unknown as SqlClient, TENANT, {
        ...referralInput,
        at: now,
        frozenAuthority: referralPreview.authority,
      });
      assert.equal(issued.ok, true, JSON.stringify(issued));
      await app.query("SET CONSTRAINTS ALL IMMEDIATE");
      await app.query("COMMIT");

      const replayAt = new Date(now.getTime() + 2 * 86_400_000);
      await admin.query(
        `UPDATE campaigns
            SET ends_at=$2::timestamptz, version=version+1,
                updated_by_staff_id=$3, updated_at=$4
          WHERE org_id=$1 AND id=$5`,
        [ID.org, new Date(now.getTime() + 3_600_000), ID.staff, now, ID.campaign],
      );
      await admin.query(
        `UPDATE coupons SET status='retired', version=version+1,
                updated_by_staff_id=$2, updated_at=$3
          WHERE org_id=$1 AND id=$4`,
        [ID.org, ID.staff, now, ID.coupon],
      );
      await beginTenant(app);
      const replayPreview = await store.previewReferralReward(app as unknown as SqlClient, TENANT, {
        ...referralInput,
        at: replayAt,
      });
      assert.equal(replayPreview.ok, true, JSON.stringify(replayPreview));
      if (!replayPreview.ok) throw new Error("exact referral replay authority unavailable");
      assert.equal(replayPreview.authority.budget_remaining_cents, 500);
      const replayedReward = await store.issueReferralReward(app as unknown as SqlClient, TENANT, {
        ...referralInput,
        at: replayAt,
        frozenAuthority: replayPreview.authority,
      });
      assert.equal(replayedReward.ok, true, JSON.stringify(replayedReward));
      if (!replayedReward.ok) throw new Error("exact referral replay failed");
      assert.equal(replayedReward.reward.replayed, true);
      assert.equal(replayedReward.reward.reward_id, ID.reward);
      await app.query("COMMIT");
      const replayCounts = await admin.query<Readonly<{ value: string }>>(
        `SELECT concat(
           (SELECT count(*) FROM referral_rewards WHERE org_id=$1), ':',
           (SELECT count(*) FROM coupon_grants WHERE org_id=$1), ':',
           (SELECT count(*) FROM campaign_budget_ledger WHERE org_id=$1)) AS value`,
        [ID.org],
      );
      assert.equal(replayCounts.rows[0]?.value, "1:1:1");

      await beginTenant(app);
      const registrationInput = Object.freeze({
        provider: "meituan" as const,
        external_order_ref: "item9-mt-1",
        voucher_code_digest: DIGEST,
        voucher_code_last4: "9999",
        label: "Real PG group buy",
        face_value_cents: 3_000,
        expires_at: expiry.toISOString(),
        reason: "real PG registration",
      });
      const registrationPreview = await store.previewGroupBuyRegistration(
        app as unknown as SqlClient,
        TENANT,
        { ...registrationInput, at: now },
      );
      assert.equal(registrationPreview.ok, true, JSON.stringify(registrationPreview));
      if (!registrationPreview.ok) throw new Error("registration authority unavailable");
      const registered = await store.registerGroupBuyVoucher(app as unknown as SqlClient, TENANT, {
        ...registrationInput,
        at: now,
        frozenAuthority: registrationPreview.authority,
      });
      assert.equal(registered.ok, true, JSON.stringify(registered));
      await app.query("COMMIT");

      await beginTenant(app);
      const redemptionInput = Object.freeze({
        voucher_code_digest: DIGEST,
        order_id: ID.groupOrder,
        reason: "real PG redemption",
      });
      const redemptionPreview = await store.previewGroupBuyRedemption(
        app as unknown as SqlClient,
        TENANT,
        { ...redemptionInput, at: now },
      );
      assert.equal(redemptionPreview.ok, true, JSON.stringify(redemptionPreview));
      if (!redemptionPreview.ok) throw new Error("redemption authority unavailable");
      await admin.query(
        `UPDATE orders SET payable_cents=7000, balance_cents=7000, updated_at=$2
          WHERE org_id=$1 AND id=$3`,
        [ID.org, now, ID.groupOrder],
      );
      const currentRedemptionPreview = await store.previewGroupBuyRedemption(
        app as unknown as SqlClient,
        TENANT,
        { ...redemptionInput, at: now },
      );
      assert.equal(currentRedemptionPreview.ok, true, JSON.stringify(currentRedemptionPreview));
      if (!currentRedemptionPreview.ok) throw new Error("current redemption authority unavailable");
      assert.equal(redemptionPreview.authority.order_payable_before_cents, 8_000);
      assert.equal(currentRedemptionPreview.authority.order_payable_before_cents, 7_000);
      const redeemed = await store.redeemGroupBuyVoucher(app as unknown as SqlClient, TENANT, {
        ...redemptionInput,
        at: now,
        frozenAuthority: currentRedemptionPreview.authority,
      });
      assert.equal(redeemed.ok, true, JSON.stringify(redeemed));
      await app.query("COMMIT");

      await beginTenant(app);
      const staleCardResume = await store.redeemGroupBuyVoucher(
        app as unknown as SqlClient,
        TENANT,
        {
          ...redemptionInput,
          at: now,
          frozenAuthority: redemptionPreview.authority,
        },
      );
      assert.deepEqual(staleCardResume, { ok: false, reason: "authority_drift" });
      await app.query("ROLLBACK");

      const evidence = await admin.query<Readonly<{ value: string }>>(
        `SELECT concat(
           (SELECT count(*) FROM referral_rewards WHERE org_id=$1), ':',
           (SELECT count(*) FROM coupon_grants WHERE org_id=$1), ':',
           (SELECT COALESCE(sum(amount_cents),0) FROM campaign_budget_ledger WHERE org_id=$1), ':',
           (SELECT count(*) FROM group_buy_vouchers WHERE org_id=$1 AND code_digest=$2), ':',
           (SELECT count(*) FROM group_buy_redemptions WHERE org_id=$1), ':',
           (SELECT payable_cents FROM orders WHERE id=$3)) AS value`,
        [ID.org, DIGEST, ID.groupOrder],
      );
      assert.equal(evidence.rows[0]?.value, "1:1:500:1:1:4000");

      await beginTenant(app);
      const changedReferral = await store.issueReferralReward(app as unknown as SqlClient, TENANT, {
        ...referralInput,
        reason: "changed referral meaning",
        at: now,
        frozenAuthority: Object.freeze({
          ...referralPreview.authority,
          reason: "changed referral meaning",
        }),
      });
      assert.deepEqual(changedReferral, { ok: false, reason: "already_rewarded" });
      const changedRegistration = await store.previewGroupBuyRegistration(
        app as unknown as SqlClient,
        TENANT,
        { ...registrationInput, reason: "changed registration meaning", at: now },
      );
      assert.deepEqual(changedRegistration, { ok: false, reason: "voucher_conflict" });
      const changedRedemption = await store.previewGroupBuyRedemption(
        app as unknown as SqlClient,
        TENANT,
        { ...redemptionInput, reason: "changed redemption meaning", at: now },
      );
      assert.deepEqual(changedRedemption, { ok: false, reason: "voucher_redeemed" });
      await app.query("ROLLBACK");

      await beginTenant(app);
      await app.query("SELECT set_config('app.store_id',$1,true)", [
        "92000000-0000-4000-8000-000000000001",
      ]);
      const crossStore = await app.query("SELECT id FROM group_buy_vouchers WHERE org_id=$1", [
        ID.org,
      ]);
      assert.equal(crossStore.rowCount, 0);
      await assert.rejects(
        () =>
          app.query("UPDATE group_buy_vouchers SET label='forbidden' WHERE id=$1", [ID.voucher]),
        /permission denied/u,
      );
      await app.query("ROLLBACK");
    } finally {
      await app.query("ROLLBACK").catch(() => undefined);
      await cleanup(admin).catch(() => undefined);
      app.release();
      admin.release();
      await appPool.end();
      await adminPool.end();
    }
  },
);
