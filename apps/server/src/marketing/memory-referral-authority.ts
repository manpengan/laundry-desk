import type { MarketingReferralRewardAuthority } from "@laundry/contracts";

import type { MarketingExtensionMemoryAccess } from "./memory-extension-types.js";
import type { MarketingExtensionStore } from "./extension-types.js";

const failure = <T extends string>(reason: T) => Object.freeze({ ok: false as const, reason });

export async function resolveMemoryReferralAuthority(
  access: MarketingExtensionMemoryAccess,
  tenant: Parameters<MarketingExtensionStore["previewReferralReward"]>[1],
  input: Parameters<MarketingExtensionStore["previewReferralReward"]>[2],
) {
  const campaign = access.getCampaign(input.campaign_id);
  if (campaign === undefined) return failure("missing");
  if (campaign.version !== input.expected_version) return failure("stale");
  if (campaign.status !== "scheduled") return failure("campaign_inactive");
  if (input.at < campaign.startsAt || input.at >= campaign.endsAt) {
    return failure("campaign_outside_window");
  }
  if (input.referrer_customer_id === input.referred_customer_id) return failure("self_referral");
  if (
    !access.customers.some((row) => row.customerId === input.referrer_customer_id) ||
    !access.customers.some((row) => row.customerId === input.referred_customer_id)
  ) {
    return failure("customer_invalid");
  }
  if (
    access.memberStore === undefined ||
    access.memberBenefits === undefined ||
    access.orderStore === undefined
  ) {
    return failure("account_invalid");
  }
  const [referrer, referred, order, catalog] = await Promise.all([
    access.memberStore.getByCustomer(input.referrer_customer_id, 0),
    access.memberStore.getByCustomer(input.referred_customer_id, 0),
    access.orderStore.getOrder(tenant.orgId, tenant.storeId, input.qualifying_order_id),
    access.memberBenefits.getCatalog(true),
  ]);
  if (
    referrer?.account.status !== "active" ||
    referred?.account.status !== "active" ||
    referrer.account.account_id === referred.account.account_id
  ) {
    return failure("account_invalid");
  }
  if (
    order === null ||
    order.customer_id !== input.referred_customer_id ||
    order.status !== "closed" ||
    order.balance_cents !== 0 ||
    order.paid_cents <= 0
  ) {
    return failure("order_invalid");
  }
  const coupon = catalog.coupon_types.find(
    (row) => row.definition_id === input.coupon_definition_id,
  );
  if (coupon === undefined) return failure("coupon_missing");
  if (coupon.status !== "active") return failure("coupon_retired");
  const remaining = campaign.budgetLimitCents - campaign.budgetUsedCents;
  if (coupon.discount_cents > remaining) return failure("budget_exceeded");
  const authority: MarketingReferralRewardAuthority = Object.freeze({
    kind: "marketing_referral_reward",
    campaign_id: campaign.campaignId,
    campaign_version: campaign.version,
    referrer_customer_id: referrer.account.customer_id,
    referrer_account_id: referrer.account.account_id,
    referred_customer_id: referred.account.customer_id,
    referred_account_id: referred.account.account_id,
    qualifying_order_id: order.order_id,
    coupon_definition_id: coupon.definition_id,
    coupon_version: coupon.version,
    coupon_code: coupon.code,
    coupon_name: coupon.name,
    coupon_discount_cents: coupon.discount_cents,
    coupon_min_order_cents: coupon.min_order_cents,
    coupon_valid_days: coupon.valid_days,
    budget_remaining_cents: remaining,
    reason: input.reason,
  });
  return Object.freeze({ ok: true as const, authority });
}
