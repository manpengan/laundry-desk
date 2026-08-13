import { z } from "zod";

import { ExactUtcTimestampSchema } from "../edge/primitives.js";

const VersionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const MoneySchema = z.number().int().positive().max(5_000_000);
const ReasonSchema = z.string().trim().min(1).max(256);
const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const ProviderSchema = z.enum(["meituan", "douyin", "wechat", "other"]);

export const MarketingReferralRewardAuthoritySchema = z.strictObject({
  kind: z.literal("marketing_referral_reward"),
  campaign_id: z.uuid(),
  campaign_version: VersionSchema,
  referrer_customer_id: z.uuid(),
  referrer_account_id: z.uuid(),
  referred_customer_id: z.uuid(),
  referred_account_id: z.uuid(),
  qualifying_order_id: z.uuid(),
  coupon_definition_id: z.uuid(),
  coupon_version: VersionSchema,
  coupon_code: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u),
  coupon_name: z.string().trim().min(1).max(64),
  coupon_discount_cents: MoneySchema,
  coupon_min_order_cents: z.number().int().nonnegative().max(5_000_000),
  coupon_valid_days: z.number().int().min(1).max(3_650),
  budget_remaining_cents: z.number().int().nonnegative().max(5_000_000),
  reason: ReasonSchema,
});

export const MarketingReferralRewardConfirmationSummarySchema =
  MarketingReferralRewardAuthoritySchema.omit({
    referrer_account_id: true,
    referred_account_id: true,
  });

export const MarketingGroupBuyRegistrationAuthoritySchema = z.strictObject({
  kind: z.literal("marketing_group_buy_registration"),
  code_digest: DigestSchema,
  code_last4: z.string().regex(/^[A-Za-z0-9]{4}$/u),
  provider: ProviderSchema,
  external_order_ref: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(64),
  face_value_cents: MoneySchema,
  expires_at: ExactUtcTimestampSchema,
  reason: ReasonSchema,
});

export const MarketingGroupBuyRegistrationConfirmationSummarySchema =
  MarketingGroupBuyRegistrationAuthoritySchema.omit({ code_digest: true });

export const MarketingGroupBuyRedemptionAuthoritySchema = z.strictObject({
  kind: z.literal("marketing_group_buy_redemption"),
  voucher_id: z.uuid(),
  code_digest: DigestSchema,
  code_last4: z.string().regex(/^[A-Za-z0-9]{4}$/u),
  provider: ProviderSchema,
  external_order_ref: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(64),
  face_value_cents: MoneySchema,
  expires_at: ExactUtcTimestampSchema,
  order_id: z.uuid(),
  order_original_cents: MoneySchema,
  order_payable_before_cents: MoneySchema,
  applied_discount_cents: MoneySchema,
  reason: ReasonSchema,
});

export const MarketingGroupBuyRedemptionConfirmationSummarySchema =
  MarketingGroupBuyRedemptionAuthoritySchema.omit({ code_digest: true });

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type MarketingReferralRewardAuthority = DeepReadonly<
  z.output<typeof MarketingReferralRewardAuthoritySchema>
>;
export type MarketingReferralRewardConfirmationSummary = DeepReadonly<
  z.output<typeof MarketingReferralRewardConfirmationSummarySchema>
>;
export type MarketingGroupBuyRegistrationAuthority = DeepReadonly<
  z.output<typeof MarketingGroupBuyRegistrationAuthoritySchema>
>;
export type MarketingGroupBuyRegistrationConfirmationSummary = DeepReadonly<
  z.output<typeof MarketingGroupBuyRegistrationConfirmationSummarySchema>
>;
export type MarketingGroupBuyRedemptionAuthority = DeepReadonly<
  z.output<typeof MarketingGroupBuyRedemptionAuthoritySchema>
>;
export type MarketingGroupBuyRedemptionConfirmationSummary = DeepReadonly<
  z.output<typeof MarketingGroupBuyRedemptionConfirmationSummarySchema>
>;
