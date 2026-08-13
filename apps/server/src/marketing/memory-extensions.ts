import type {
  MarketingGroupBuyRedemption,
  MarketingGroupBuyRegistrationAuthority,
  MarketingGroupBuyVoucher,
  MarketingReferralReward,
} from "@laundry/contracts";

import {
  sameGroupBuyRedemptionAuthority,
  sameGroupBuyRegistrationAuthority,
  sameReferralRewardAuthority,
} from "./extension-authority.js";
import type { MarketingExtensionStore } from "./extension-types.js";
import type {
  MarketingExtensionMemoryAccess,
  MemoryRedemptionRecord,
  MemoryRewardRecord,
  MemoryVoucherRecord,
} from "./memory-extension-types.js";
import { resolveMemoryReferralAuthority } from "./memory-referral-authority.js";

const failure = <T extends string>(reason: T) => Object.freeze({ ok: false as const, reason });

export function createMemoryMarketingExtensionOperations(
  access: MarketingExtensionMemoryAccess,
): MarketingExtensionStore {
  let rewards = new Map<string, MemoryRewardRecord>();
  let vouchers = new Map<string, MemoryVoucherRecord>();
  let voucherByDigest = new Map<string, string>();
  let voucherByExternal = new Map<string, string>();
  let redemptions = new Map<string, MemoryRedemptionRecord>();

  const rewardCollision = (input: {
    campaign_id: string;
    referred_customer_id: string;
    qualifying_order_id: string;
  }) =>
    [...rewards.values()].find(
      ({ public: row }) =>
        row.qualifying_order_id === input.qualifying_order_id ||
        (row.campaign_id === input.campaign_id &&
          row.referred_customer_id === input.referred_customer_id),
    );

  const rewardMatches = (
    existing: MemoryRewardRecord,
    input: Parameters<MarketingExtensionStore["previewReferralReward"]>[2],
  ) => {
    const reward = existing.public;
    return (
      reward.campaign_id === input.campaign_id &&
      reward.campaign_version === input.expected_version &&
      reward.referrer_customer_id === input.referrer_customer_id &&
      reward.referred_customer_id === input.referred_customer_id &&
      reward.qualifying_order_id === input.qualifying_order_id &&
      reward.coupon_definition_id === input.coupon_definition_id &&
      existing.reason === input.reason
    );
  };

  const registrationAuthority = (
    input: Parameters<MarketingExtensionStore["previewGroupBuyRegistration"]>[2],
  ) => {
    const digest = input.voucher_code_digest;
    const externalKey = `${input.provider}:${input.external_order_ref}`;
    const existingId = voucherByDigest.get(digest) ?? voucherByExternal.get(externalKey);
    const replayed = existingId !== undefined;
    if (existingId !== undefined) {
      const existing = vouchers.get(existingId);
      if (
        existing === undefined ||
        existing.digest !== digest ||
        existing.public.code_last4 !== input.voucher_code_last4 ||
        existing.public.provider !== input.provider ||
        existing.public.external_order_ref !== input.external_order_ref ||
        existing.public.label !== input.label ||
        existing.public.face_value_cents !== input.face_value_cents ||
        existing.public.expires_at !== input.expires_at ||
        existing.reason !== input.reason
      ) {
        return failure("voucher_conflict");
      }
    }
    const maxExpiry = new Date(input.at);
    maxExpiry.setUTCFullYear(maxExpiry.getUTCFullYear() + 5);
    if (
      !replayed &&
      (new Date(input.expires_at) <= input.at || new Date(input.expires_at) > maxExpiry)
    ) {
      return failure("voucher_expired");
    }
    const authority: MarketingGroupBuyRegistrationAuthority = Object.freeze({
      kind: "marketing_group_buy_registration",
      code_digest: digest,
      code_last4: input.voucher_code_last4,
      provider: input.provider,
      external_order_ref: input.external_order_ref,
      label: input.label,
      face_value_cents: input.face_value_cents,
      expires_at: input.expires_at,
      reason: input.reason,
    });
    return Object.freeze({ ok: true as const, authority });
  };

  const redemptionAuthority = async (
    tenant: Parameters<MarketingExtensionStore["previewGroupBuyRedemption"]>[1],
    input: Parameters<MarketingExtensionStore["previewGroupBuyRedemption"]>[2],
  ) => {
    const digest = input.voucher_code_digest;
    const voucherId = voucherByDigest.get(digest);
    const voucher = voucherId === undefined ? undefined : vouchers.get(voucherId);
    if (voucher === undefined) return failure("missing");
    const existing = redemptions.get(voucher.public.voucher_id);
    if (existing !== undefined && existing.public.order_id !== input.order_id) {
      return failure("voucher_redeemed");
    }
    if (existing !== undefined && existing.reason !== input.reason) {
      return failure("voucher_redeemed");
    }
    const order = await access.orderStore?.getOrder(tenant.orgId, tenant.storeId, input.order_id);
    if (existing !== undefined) {
      return Object.freeze({
        ok: true as const,
        authority: Object.freeze({
          kind: "marketing_group_buy_redemption" as const,
          voucher_id: voucher.public.voucher_id,
          code_digest: digest,
          code_last4: voucher.public.code_last4,
          provider: voucher.public.provider,
          external_order_ref: voucher.public.external_order_ref,
          label: voucher.public.label,
          face_value_cents: voucher.public.face_value_cents,
          expires_at: voucher.public.expires_at,
          order_id: existing.public.order_id,
          order_original_cents: existing.orderOriginalCents,
          order_payable_before_cents: existing.orderPayableBeforeCents,
          applied_discount_cents: existing.public.applied_discount_cents,
          reason: input.reason,
        }),
      });
    }
    if (new Date(voucher.public.expires_at) <= input.at) return failure("voucher_expired");
    if (
      order === null ||
      order === undefined ||
      order.customer_id === null ||
      order.status !== "open" ||
      order.paid_cents !== 0 ||
      order.discount_cents !== 0 ||
      order.original_cents <= 0
    ) {
      return failure("order_invalid");
    }
    const applied = Math.min(voucher.public.face_value_cents, order.original_cents);
    if (applied <= 0 || applied > order.payable_cents) return failure("order_invalid");
    return Object.freeze({
      ok: true as const,
      authority: Object.freeze({
        kind: "marketing_group_buy_redemption" as const,
        voucher_id: voucher.public.voucher_id,
        code_digest: digest,
        code_last4: voucher.public.code_last4,
        provider: voucher.public.provider,
        external_order_ref: voucher.public.external_order_ref,
        label: voucher.public.label,
        face_value_cents: voucher.public.face_value_cents,
        expires_at: voucher.public.expires_at,
        order_id: order.order_id,
        order_original_cents: order.original_cents,
        order_payable_before_cents: order.payable_cents,
        applied_discount_cents: applied,
        reason: input.reason,
      }),
    });
  };

  return Object.freeze({
    previewReferralReward: async (_client, tenant, input) => {
      const existing = rewardCollision(input);
      if (existing === undefined) return resolveMemoryReferralAuthority(access, tenant, input);
      return rewardMatches(existing, input)
        ? Object.freeze({ ok: true, authority: existing.authority })
        : failure("already_rewarded");
    },
    issueReferralReward: async (_client, tenant, input) => {
      const existing = rewardCollision(input);
      if (existing !== undefined) {
        const reward = existing.public;
        if (!rewardMatches(existing, input)) return failure("already_rewarded");
        return sameReferralRewardAuthority(existing.authority, input.frozenAuthority)
          ? Object.freeze({ ok: true, reward: Object.freeze({ ...reward, replayed: true }) })
          : failure("authority_drift");
      }
      const resolved = await resolveMemoryReferralAuthority(access, tenant, input);
      if (!resolved.ok) return resolved;
      if (!sameReferralRewardAuthority(resolved.authority, input.frozenAuthority)) {
        return failure("authority_drift");
      }
      const benefits = access.memberBenefits;
      if (benefits === undefined) return failure("account_invalid");
      const granted = await benefits.grantAsset({
        asset_kind: "coupon",
        account_id: resolved.authority.referrer_account_id,
        definition_id: resolved.authority.coupon_definition_id,
        reason: input.reason,
        store_id: tenant.storeId,
        staff_id: tenant.staffId,
        at: Math.floor(input.at.getTime() / 1_000),
        business_date: input.at.toISOString().slice(0, 10),
      });
      if (!granted.ok) return failure("authority_drift");
      const reward: MarketingReferralReward = Object.freeze({
        reward_id: access.newId(),
        campaign_id: input.campaign_id,
        campaign_version: input.expected_version,
        referrer_customer_id: input.referrer_customer_id,
        referred_customer_id: input.referred_customer_id,
        qualifying_order_id: input.qualifying_order_id,
        coupon_definition_id: input.coupon_definition_id,
        coupon_code: resolved.authority.coupon_code,
        coupon_name: resolved.authority.coupon_name,
        coupon_grant_id: granted.value.entity_id,
        reward_cents: resolved.authority.coupon_discount_cents,
        budget_committed_cents: resolved.authority.coupon_discount_cents,
        created_at: input.at.toISOString(),
        replayed: false,
      });
      const next = new Map(rewards);
      next.set(
        reward.reward_id,
        Object.freeze({ public: reward, authority: resolved.authority, reason: input.reason }),
      );
      rewards = next;
      access.commitBudget(input.campaign_id, reward.budget_committed_cents);
      return Object.freeze({ ok: true, reward });
    },
    previewGroupBuyRegistration: async (_client, _tenant, input) => registrationAuthority(input),
    registerGroupBuyVoucher: async (_client, _tenant, input) => {
      const resolved = registrationAuthority(input);
      if (!resolved.ok) return resolved;
      if (!sameGroupBuyRegistrationAuthority(resolved.authority, input.frozenAuthority)) {
        return failure("authority_drift");
      }
      const existingId = voucherByDigest.get(resolved.authority.code_digest);
      if (existingId !== undefined) {
        const existing = vouchers.get(existingId);
        if (existing === undefined) throw new Error("voucher digest index is corrupt");
        return Object.freeze({
          ok: true,
          voucher: Object.freeze({ ...existing.public, replayed: true }),
        });
      }
      const voucher: MarketingGroupBuyVoucher = Object.freeze({
        voucher_id: access.newId(),
        provider: input.provider,
        external_order_ref: input.external_order_ref,
        code_last4: resolved.authority.code_last4,
        label: input.label,
        face_value_cents: input.face_value_cents,
        expires_at: input.expires_at,
        registered_at: input.at.toISOString(),
        replayed: false,
      });
      const nextVouchers = new Map(vouchers);
      nextVouchers.set(
        voucher.voucher_id,
        Object.freeze({
          public: voucher,
          digest: resolved.authority.code_digest,
          reason: input.reason,
        }),
      );
      vouchers = nextVouchers;
      const nextDigest = new Map(voucherByDigest);
      nextDigest.set(resolved.authority.code_digest, voucher.voucher_id);
      voucherByDigest = nextDigest;
      const nextExternal = new Map(voucherByExternal);
      nextExternal.set(`${input.provider}:${input.external_order_ref}`, voucher.voucher_id);
      voucherByExternal = nextExternal;
      return Object.freeze({ ok: true, voucher });
    },
    previewGroupBuyRedemption: async (_client, tenant, input) => redemptionAuthority(tenant, input),
    redeemGroupBuyVoucher: async (_client, tenant, input) => {
      const resolved = await redemptionAuthority(tenant, input);
      if (!resolved.ok) return resolved;
      const existing = redemptions.get(resolved.authority.voucher_id);
      if (existing !== undefined) {
        if (!sameGroupBuyRedemptionAuthority(resolved.authority, input.frozenAuthority)) {
          return failure("authority_drift");
        }
        return Object.freeze({
          ok: true,
          redemption: Object.freeze({ ...existing.public, replayed: true }),
        });
      }
      if (!sameGroupBuyRedemptionAuthority(resolved.authority, input.frozenAuthority)) {
        return failure("authority_drift");
      }
      const order = await access.orderStore?.getOrder(tenant.orgId, tenant.storeId, input.order_id);
      if (order?.customer_id === null || order === null || order === undefined) {
        return failure("order_invalid");
      }
      const discounted = await access.orderStore?.applyFixedCouponDiscount?.({
        org_id: tenant.orgId,
        store_id: tenant.storeId,
        order_id: input.order_id,
        customer_id: order.customer_id,
        discount_cents: resolved.authority.applied_discount_cents,
        min_order_cents: 0,
        at: Math.floor(input.at.getTime() / 1_000),
      });
      if (discounted === null || discounted === undefined) return failure("order_invalid");
      const redemption: MarketingGroupBuyRedemption = Object.freeze({
        redemption_id: access.newId(),
        voucher_id: resolved.authority.voucher_id,
        provider: resolved.authority.provider,
        external_order_ref: resolved.authority.external_order_ref,
        code_last4: resolved.authority.code_last4,
        order_id: input.order_id,
        face_value_cents: resolved.authority.face_value_cents,
        applied_discount_cents: discounted.applied_discount_cents,
        redeemed_at: input.at.toISOString(),
        replayed: false,
      });
      const next = new Map(redemptions);
      next.set(
        redemption.voucher_id,
        Object.freeze({
          public: redemption,
          orderOriginalCents: resolved.authority.order_original_cents,
          orderPayableBeforeCents: resolved.authority.order_payable_before_cents,
          reason: input.reason,
        }),
      );
      redemptions = next;
      return Object.freeze({ ok: true, redemption });
    },
  });
}
