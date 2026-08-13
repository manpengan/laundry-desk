import type { MarketingReferralReward, MarketingReferralRewardAuthority } from "@laundry/contracts";

import { marketingInteger, marketingTimestamp } from "./pg-extension-support.js";

export type ReferralRewardRow = Readonly<{
  reward_id: string;
  campaign_id: string;
  campaign_version: number | string;
  referrer_customer_id: string;
  referrer_account_id: string;
  referred_customer_id: string;
  referred_account_id: string;
  qualifying_order_id: string;
  coupon_definition_id: string;
  coupon_version: number | string;
  coupon_code: string;
  coupon_name: string;
  coupon_discount_cents: number | string;
  coupon_min_order_cents: number | string;
  coupon_valid_days: number | string;
  coupon_grant_id: string;
  reward_cents: number | string;
  budget_remaining_before_cents: number | string;
  reason: string;
  created_at: Date | string;
}>;

export function wireReferralReward(
  row: ReferralRewardRow,
  replayed: boolean,
): MarketingReferralReward {
  const reward = marketingInteger(row.reward_cents, "referral reward");
  return Object.freeze({
    reward_id: row.reward_id,
    campaign_id: row.campaign_id,
    campaign_version: marketingInteger(row.campaign_version, "campaign version"),
    referrer_customer_id: row.referrer_customer_id,
    referred_customer_id: row.referred_customer_id,
    qualifying_order_id: row.qualifying_order_id,
    coupon_definition_id: row.coupon_definition_id,
    coupon_code: row.coupon_code,
    coupon_name: row.coupon_name,
    coupon_grant_id: row.coupon_grant_id,
    reward_cents: reward,
    budget_committed_cents: reward,
    created_at: marketingTimestamp(row.created_at, "referral reward timestamp"),
    replayed,
  });
}

export function wireReferralAuthority(row: ReferralRewardRow): MarketingReferralRewardAuthority {
  return Object.freeze({
    kind: "marketing_referral_reward",
    campaign_id: row.campaign_id,
    campaign_version: marketingInteger(row.campaign_version, "campaign version"),
    referrer_customer_id: row.referrer_customer_id,
    referrer_account_id: row.referrer_account_id,
    referred_customer_id: row.referred_customer_id,
    referred_account_id: row.referred_account_id,
    qualifying_order_id: row.qualifying_order_id,
    coupon_definition_id: row.coupon_definition_id,
    coupon_version: marketingInteger(row.coupon_version, "referral coupon version"),
    coupon_code: row.coupon_code,
    coupon_name: row.coupon_name,
    coupon_discount_cents: marketingInteger(row.coupon_discount_cents, "referral discount"),
    coupon_min_order_cents: marketingInteger(row.coupon_min_order_cents, "coupon minimum"),
    coupon_valid_days: marketingInteger(row.coupon_valid_days, "coupon validity"),
    budget_remaining_cents: marketingInteger(
      row.budget_remaining_before_cents,
      "referral budget remaining",
    ),
    reason: row.reason,
  });
}
