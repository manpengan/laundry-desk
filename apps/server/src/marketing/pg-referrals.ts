import type {
  MarketingReferralReward,
  MarketingReferralRewardAuthority,
  MarketingReferralRewardIssueInput,
} from "@laundry/contracts";

import type { SqlClient, TenantContext } from "../db/types.js";
import { sameReferralRewardAuthority } from "./extension-authority.js";
import type {
  MarketingExtensionRejectReason,
  MarketingExtensionStore,
  MarketingReferralAuthorityResult,
  MarketingReferralRewardResult,
} from "./extension-types.js";
import { marketingInteger } from "./pg-extension-support.js";
import type { MarketingCampaignRecord } from "./types.js";
import {
  wireReferralAuthority,
  wireReferralReward,
  type ReferralRewardRow,
} from "./pg-referral-evidence.js";

type CampaignLoader = (
  client: SqlClient,
  tenant: TenantContext,
  campaignId: string,
  lock: boolean,
) => Promise<MarketingCampaignRecord | null>;

type AccountRow = Readonly<{
  customer_id: string;
  account_id: string;
  status: string;
  merged_into_id: string | null;
  anonymized_at: Date | string | null;
}>;
type OrderRow = Readonly<{
  id: string;
  customer_id: string | null;
  status: string;
  paid_cents: number | string;
  balance_cents: number | string;
}>;
type CouponRow = Readonly<{
  id: string;
  code: string;
  name: string;
  discount_cents: number | string;
  min_order_cents: number | string;
  valid_days: number | string;
  version: number | string;
  status: string;
}>;
const failure = (reason: MarketingExtensionRejectReason) => Object.freeze({ ok: false, reason });

async function readReward(
  client: SqlClient,
  tenant: TenantContext,
  input: Pick<
    MarketingReferralRewardIssueInput,
    | "campaign_id"
    | "expected_version"
    | "referrer_customer_id"
    | "referred_customer_id"
    | "qualifying_order_id"
    | "coupon_definition_id"
    | "reason"
  >,
): Promise<{
  reward: MarketingReferralReward | null;
  authority: MarketingReferralRewardAuthority | null;
  collision: boolean;
}> {
  const result = await client.query<ReferralRewardRow>(
    `SELECT id::text AS reward_id, campaign_id::text, campaign_version,
            referrer_customer_id::text, referrer_account_id::text,
            referred_customer_id::text, referred_account_id::text,
            qualifying_order_id::text, coupon_definition_id::text, coupon_version,
            coupon_code, coupon_name, coupon_discount_cents, coupon_min_order_cents,
            coupon_valid_days, coupon_grant_id::text, reward_cents,
            budget_remaining_before_cents, reason, created_at
       FROM referral_rewards
      WHERE org_id=$1::uuid AND store_id=$2::uuid
        AND (qualifying_order_id=$3::uuid
          OR (campaign_id=$4::uuid AND referred_customer_id=$5::uuid))
      ORDER BY id LIMIT 1`,
    [
      tenant.orgId,
      tenant.storeId,
      input.qualifying_order_id,
      input.campaign_id,
      input.referred_customer_id,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return Object.freeze({ reward: null, authority: null, collision: false });
  }
  const exact =
    row.campaign_id === input.campaign_id &&
    row.referrer_customer_id === input.referrer_customer_id &&
    row.referred_customer_id === input.referred_customer_id &&
    row.qualifying_order_id === input.qualifying_order_id &&
    row.coupon_definition_id === input.coupon_definition_id &&
    marketingInteger(row.campaign_version, "campaign version") === input.expected_version &&
    row.reason === input.reason;
  return Object.freeze({
    reward: exact ? wireReferralReward(row, true) : null,
    authority: exact ? wireReferralAuthority(row) : null,
    collision: !exact,
  });
}

async function accounts(
  client: SqlClient,
  tenant: TenantContext,
  customerIds: readonly [string, string],
  lock: boolean,
): Promise<ReadonlyMap<string, AccountRow>> {
  const orderedIds = Object.freeze([...customerIds].sort());
  const result = await client.query<AccountRow>(
    `SELECT customer_row.id::text AS customer_id, account.id::text AS account_id,
            account.status, customer_row.merged_into_id::text, customer_row.anonymized_at
       FROM customers customer_row
       JOIN member_accounts account ON account.org_id=customer_row.org_id
        AND account.customer_id=customer_row.id
      WHERE customer_row.org_id=$1::uuid AND customer_row.id=ANY($2::uuid[])
      ORDER BY customer_row.id
      ${lock ? "FOR UPDATE OF customer_row, account" : ""}`,
    [tenant.orgId, orderedIds],
  );
  return new Map(result.rows.map((row) => [row.customer_id, row] as const));
}

async function resolveReferralAuthority(
  client: SqlClient,
  tenant: TenantContext,
  input: MarketingReferralRewardIssueInput & Readonly<{ at: Date }>,
  lock: boolean,
  loadCampaign: CampaignLoader,
): Promise<MarketingReferralAuthorityResult> {
  const existing = await readReward(client, tenant, input);
  if (existing.authority !== null) {
    return Object.freeze({ ok: true, authority: existing.authority });
  }
  if (existing.collision) return failure("already_rewarded");
  const campaign = await loadCampaign(client, tenant, input.campaign_id, lock);
  if (campaign === null) return failure("missing");
  if (campaign.version !== input.expected_version) return failure("stale");
  if (campaign.status !== "scheduled") return failure("campaign_inactive");
  if (input.at < campaign.startsAt || input.at >= campaign.endsAt) {
    return failure("campaign_outside_window");
  }
  if (input.referrer_customer_id === input.referred_customer_id) return failure("self_referral");
  const accountRows = await accounts(
    client,
    tenant,
    [input.referrer_customer_id, input.referred_customer_id],
    lock,
  );
  const referrer = accountRows.get(input.referrer_customer_id) ?? null;
  const referred = accountRows.get(input.referred_customer_id) ?? null;
  if (
    referrer === null ||
    referred === null ||
    referrer.status !== "active" ||
    referred.status !== "active" ||
    referrer.merged_into_id !== null ||
    referred.merged_into_id !== null ||
    referrer.anonymized_at !== null ||
    referred.anonymized_at !== null
  ) {
    return failure("account_invalid");
  }
  const orderResult = await client.query<OrderRow>(
    `SELECT id::text, customer_id::text, status, paid_cents, balance_cents
       FROM orders WHERE org_id=$1::uuid AND store_id=$2::uuid AND id=$3::uuid
      ${lock ? "FOR UPDATE" : ""}`,
    [tenant.orgId, tenant.storeId, input.qualifying_order_id],
  );
  const order = orderResult.rows[0];
  if (
    order === undefined ||
    order.customer_id !== referred.customer_id ||
    order.status !== "closed" ||
    marketingInteger(order.balance_cents, "order balance") !== 0 ||
    marketingInteger(order.paid_cents, "order paid") <= 0
  ) {
    return failure("order_invalid");
  }
  const couponResult = await client.query<CouponRow>(
    `SELECT id::text, code, name, discount_cents, min_order_cents, valid_days, version, status
       FROM coupons WHERE org_id=$1::uuid AND id=$2::uuid ${lock ? "FOR SHARE" : ""}`,
    [tenant.orgId, input.coupon_definition_id],
  );
  const coupon = couponResult.rows[0];
  if (coupon === undefined) return failure("coupon_missing");
  if (coupon.status !== "active") return failure("coupon_retired");
  const discount = marketingInteger(coupon.discount_cents, "referral coupon discount");
  const remaining = campaign.budgetLimitCents - campaign.budgetUsedCents;
  if (discount > remaining) return failure("budget_exceeded");
  const authority: MarketingReferralRewardAuthority = Object.freeze({
    kind: "marketing_referral_reward",
    campaign_id: campaign.campaignId,
    campaign_version: campaign.version,
    referrer_customer_id: referrer.customer_id,
    referrer_account_id: referrer.account_id,
    referred_customer_id: referred.customer_id,
    referred_account_id: referred.account_id,
    qualifying_order_id: order.id,
    coupon_definition_id: coupon.id,
    coupon_version: marketingInteger(coupon.version, "referral coupon version"),
    coupon_code: coupon.code,
    coupon_name: coupon.name,
    coupon_discount_cents: discount,
    coupon_min_order_cents: marketingInteger(coupon.min_order_cents, "coupon minimum"),
    coupon_valid_days: marketingInteger(coupon.valid_days, "coupon validity"),
    budget_remaining_cents: remaining,
    reason: input.reason,
  });
  return Object.freeze({ ok: true, authority });
}

async function issueReferral(
  client: SqlClient,
  tenant: TenantContext,
  input: Parameters<MarketingExtensionStore["issueReferralReward"]>[2],
  newId: () => string,
  loadCampaign: CampaignLoader,
): Promise<MarketingReferralRewardResult> {
  const existing = await readReward(client, tenant, input);
  if (existing.reward !== null && existing.authority !== null) {
    return sameReferralRewardAuthority(existing.authority, input.frozenAuthority)
      ? Object.freeze({ ok: true, reward: existing.reward })
      : failure("authority_drift");
  }
  if (existing.collision) return failure("already_rewarded");
  const resolved = await resolveReferralAuthority(client, tenant, input, true, loadCampaign);
  if (!resolved.ok) return resolved;
  const afterLock = await readReward(client, tenant, input);
  if (afterLock.reward !== null && afterLock.authority !== null) {
    return sameReferralRewardAuthority(afterLock.authority, input.frozenAuthority)
      ? Object.freeze({ ok: true, reward: afterLock.reward })
      : failure("authority_drift");
  }
  if (afterLock.collision) return failure("already_rewarded");
  if (!sameReferralRewardAuthority(resolved.authority, input.frozenAuthority)) {
    return failure("authority_drift");
  }
  const rewardId = newId();
  const grantId = newId();
  const businessDate = await client.query<Readonly<{ value: string }>>(
    `SELECT (($3::timestamptz AT TIME ZONE timezone)::date)::text AS value
       FROM stores WHERE org_id=$1::uuid AND id=$2::uuid`,
    [tenant.orgId, tenant.storeId, input.at.toISOString()],
  );
  const grantedOn = businessDate.rows[0]?.value;
  if (grantedOn === undefined) throw new Error("store timezone is unavailable");
  await client.query(
    `INSERT INTO coupon_grants
       (id, org_id, account_id, definition_id, code, name, discount_cents,
        min_order_cents, granted_on, expires_on, granted_at,
        granted_store_id, granted_by_staff_id, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$9::date+$10::integer,$11,$12,$13,$14)`,
    [
      grantId,
      tenant.orgId,
      resolved.authority.referrer_account_id,
      resolved.authority.coupon_definition_id,
      resolved.authority.coupon_code,
      resolved.authority.coupon_name,
      resolved.authority.coupon_discount_cents,
      resolved.authority.coupon_min_order_cents,
      grantedOn,
      resolved.authority.coupon_valid_days,
      input.at.toISOString(),
      tenant.storeId,
      tenant.staffId,
      input.reason,
    ],
  );
  const inserted = await client.query<ReferralRewardRow>(
    `INSERT INTO referral_rewards
         (id, org_id, store_id, campaign_id, campaign_version,
          referrer_customer_id, referrer_account_id, referred_customer_id, referred_account_id,
          qualifying_order_id, coupon_definition_id, coupon_version, coupon_code, coupon_name,
          coupon_discount_cents, coupon_min_order_cents, coupon_valid_days, coupon_grant_id,
          reward_cents, budget_remaining_before_cents, reason, created_by_staff_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$15,$19,$20,$21,$22)
       RETURNING id::text AS reward_id, campaign_id::text, campaign_version,
         referrer_customer_id::text, referrer_account_id::text,
         referred_customer_id::text, referred_account_id::text, qualifying_order_id::text,
         coupon_definition_id::text, coupon_version, coupon_code, coupon_name,
         coupon_discount_cents, coupon_min_order_cents, coupon_valid_days, coupon_grant_id::text,
         reward_cents, budget_remaining_before_cents, reason, created_at`,
    [
      rewardId,
      tenant.orgId,
      tenant.storeId,
      input.campaign_id,
      input.expected_version,
      input.referrer_customer_id,
      resolved.authority.referrer_account_id,
      input.referred_customer_id,
      resolved.authority.referred_account_id,
      input.qualifying_order_id,
      input.coupon_definition_id,
      resolved.authority.coupon_version,
      resolved.authority.coupon_code,
      resolved.authority.coupon_name,
      resolved.authority.coupon_discount_cents,
      resolved.authority.coupon_min_order_cents,
      resolved.authority.coupon_valid_days,
      grantId,
      resolved.authority.budget_remaining_cents,
      input.reason,
      tenant.staffId,
      input.at.toISOString(),
    ],
  );
  await client.query(
    `INSERT INTO campaign_budget_ledger
         (id, org_id, store_id, campaign_id, kind, source_id, amount_cents, staff_id, at)
       VALUES ($1,$2,$3,$4,'coupon_issue',$5,$6,$7,$8)`,
    [
      newId(),
      tenant.orgId,
      tenant.storeId,
      input.campaign_id,
      rewardId,
      resolved.authority.coupon_discount_cents,
      tenant.staffId,
      input.at.toISOString(),
    ],
  );
  const row = inserted.rows[0];
  if (row === undefined) throw new Error("referral reward insert returned no row");
  return Object.freeze({ ok: true, reward: wireReferralReward(row, false) });
}

export function createPgMarketingReferralOperations(
  loadCampaign: CampaignLoader,
  newId: () => string,
): Pick<MarketingExtensionStore, "previewReferralReward" | "issueReferralReward"> {
  return Object.freeze({
    previewReferralReward: (client, tenant, input) =>
      resolveReferralAuthority(client, tenant, input, false, loadCampaign),
    issueReferralReward: (client, tenant, input) =>
      issueReferral(client, tenant, input, newId, loadCampaign),
  });
}
