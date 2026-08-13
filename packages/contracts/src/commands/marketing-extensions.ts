import { z } from "zod";

import { ExactUtcTimestampSchema } from "../edge/primitives.js";
import { defineCommand, type CommandDefinition } from "../registry/definitions.js";

const PositiveVersionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const MoneySchema = z.number().int().positive().max(5_000_000);
const ReasonSchema = z.string().trim().min(1).max(256);
const ProviderSchema = z.enum(["meituan", "douyin", "wechat", "other"]);
export const MarketingGroupBuyVoucherDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
export const MarketingGroupBuyVoucherLast4Schema = z.string().regex(/^[A-Za-z0-9]{4}$/u);

/**
 * A group-buy code is a bearer secret. Requiring at least 24 alphanumeric
 * symbols keeps the accepted format out of the short human PIN/code space.
 */
export const MarketingGroupBuyVoucherCodeSchema = z
  .string()
  .trim()
  .min(24)
  .max(128)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])$/u)
  .refine((value) => (value.match(/[A-Za-z0-9]/gu) ?? []).length >= 24, {
    message: "voucher code must contain at least 24 alphanumeric symbols",
  })
  .refine((value) => /[A-Za-z0-9]{4}$/u.test(value), {
    message: "voucher code must end with four alphanumeric symbols",
  });

export const MarketingReferralRewardIssueInputSchema = z
  .strictObject({
    campaign_id: z.uuid(),
    expected_version: PositiveVersionSchema,
    referrer_customer_id: z.uuid(),
    referred_customer_id: z.uuid(),
    qualifying_order_id: z.uuid(),
    coupon_definition_id: z.uuid(),
    reason: ReasonSchema,
  })
  .refine((value) => value.referrer_customer_id !== value.referred_customer_id, {
    path: ["referred_customer_id"],
    message: "referrer and referred customer must differ",
  });

export const MarketingReferralRewardSchema = z.strictObject({
  reward_id: z.uuid(),
  campaign_id: z.uuid(),
  campaign_version: PositiveVersionSchema,
  referrer_customer_id: z.uuid(),
  referred_customer_id: z.uuid(),
  qualifying_order_id: z.uuid(),
  coupon_definition_id: z.uuid(),
  coupon_code: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u),
  coupon_name: z.string().trim().min(1).max(64),
  coupon_grant_id: z.uuid(),
  reward_cents: MoneySchema,
  budget_committed_cents: MoneySchema,
  created_at: ExactUtcTimestampSchema,
  replayed: z.boolean(),
});

export const MarketingReferralRewardIssueResultSchema = z.strictObject({
  reward: MarketingReferralRewardSchema,
});

export const MarketingGroupBuyVoucherRegisterInputSchema = z.strictObject({
  provider: ProviderSchema,
  external_order_ref: z.string().trim().min(1).max(64),
  voucher_code_digest: MarketingGroupBuyVoucherDigestSchema,
  voucher_code_last4: MarketingGroupBuyVoucherLast4Schema,
  label: z.string().trim().min(1).max(64),
  face_value_cents: MoneySchema,
  expires_at: ExactUtcTimestampSchema,
  reason: ReasonSchema,
});

export const MarketingGroupBuyVoucherSchema = z.strictObject({
  voucher_id: z.uuid(),
  provider: ProviderSchema,
  external_order_ref: z.string().trim().min(1).max(64),
  code_last4: MarketingGroupBuyVoucherLast4Schema,
  label: z.string().trim().min(1).max(64),
  face_value_cents: MoneySchema,
  expires_at: ExactUtcTimestampSchema,
  registered_at: ExactUtcTimestampSchema,
  replayed: z.boolean(),
});

export const MarketingGroupBuyVoucherRegisterResultSchema = z.strictObject({
  voucher: MarketingGroupBuyVoucherSchema,
});

export const MarketingGroupBuyVoucherRedeemInputSchema = z.strictObject({
  voucher_code_digest: MarketingGroupBuyVoucherDigestSchema,
  order_id: z.uuid(),
  reason: ReasonSchema,
});

export const MarketingGroupBuyRedemptionSchema = z.strictObject({
  redemption_id: z.uuid(),
  voucher_id: z.uuid(),
  provider: ProviderSchema,
  external_order_ref: z.string().trim().min(1).max(64),
  code_last4: MarketingGroupBuyVoucherLast4Schema,
  order_id: z.uuid(),
  face_value_cents: MoneySchema,
  applied_discount_cents: MoneySchema,
  redeemed_at: ExactUtcTimestampSchema,
  replayed: z.boolean(),
});

export const MarketingGroupBuyVoucherRedeemResultSchema = z.strictObject({
  redemption: MarketingGroupBuyRedemptionSchema,
});

const referralRewardCommand: CommandDefinition<typeof MarketingReferralRewardIssueInputSchema> =
  defineCommand({
    name: "marketing.referral.reward.issue",
    version: "0.1.0",
    description:
      "Grant one campaign-budgeted referral coupon after server verification of a settled order.",
    description_llm:
      "R4 admin operation. Customer identity, member eligibility, coupon value and budget are server-authoritative.",
    input: MarketingReferralRewardIssueInputSchema,
    risk: "R4",
    invariants: [
      "rbac.marketing_manage",
      "marketing.feature_enabled",
      "marketing.referral_qualified",
      "marketing.campaign_budget_available",
    ],
    idempotent: true,
    sideEffects: [
      "marketing.referral_reward_issued",
      "member.coupon_granted",
      "audit.marketing_referral_reward_issued",
    ],
    offline_mode: "denied",
    data_classification: "pii",
    input_redaction: [
      { path: "/referrer_customer_id", strategy: "remove" },
      { path: "/referred_customer_id", strategy: "remove" },
      { path: "/reason", strategy: "mask" },
    ],
    result_redaction: [
      { path: "/reward/referrer_customer_id", strategy: "remove" },
      { path: "/reward/referred_customer_id", strategy: "remove" },
    ],
  });

const groupBuyVoucherRegisterCommand: CommandDefinition<
  typeof MarketingGroupBuyVoucherRegisterInputSchema
> = defineCommand({
  name: "marketing.group_buy.voucher.register",
  version: "0.1.0",
  description: "Register one externally purchased, high-entropy, single-use group-buy voucher.",
  description_llm:
    "R4 admin operation. The client validates and hashes the bearer code; only its digest crosses this boundary.",
  input: MarketingGroupBuyVoucherRegisterInputSchema,
  risk: "R4",
  invariants: [
    "rbac.marketing_manage",
    "marketing.feature_enabled",
    "marketing.group_buy_voucher_unique",
  ],
  idempotent: true,
  sideEffects: ["marketing.group_buy_voucher_registered", "audit.group_buy_voucher_registered"],
  offline_mode: "denied",
  data_classification: "secret",
  input_redaction: [
    { path: "/voucher_code_digest", strategy: "remove" },
    { path: "/reason", strategy: "remove" },
  ],
  result_redaction: [],
});

const groupBuyVoucherRedeemCommand: CommandDefinition<
  typeof MarketingGroupBuyVoucherRedeemInputSchema
> = defineCommand({
  name: "marketing.group_buy.voucher.redeem",
  version: "0.1.0",
  description:
    "Consume one registered group-buy voucher against one open unpaid order and append redemption evidence.",
  description_llm:
    "R4 admin operation. The server resolves the voucher value and applies the bounded discount atomically.",
  input: MarketingGroupBuyVoucherRedeemInputSchema,
  risk: "R4",
  invariants: [
    "rbac.marketing_manage",
    "marketing.feature_enabled",
    "marketing.group_buy_voucher_active",
    "marketing.order_unpaid_and_open",
  ],
  idempotent: true,
  sideEffects: [
    "marketing.group_buy_voucher_redeemed",
    "order.discount_applied",
    "audit.group_buy_voucher_redeemed",
  ],
  offline_mode: "denied",
  data_classification: "secret",
  input_redaction: [
    { path: "/voucher_code_digest", strategy: "remove" },
    { path: "/reason", strategy: "remove" },
  ],
  result_redaction: [],
});

export const MARKETING_EXTENSION_COMMANDS = Object.freeze([
  referralRewardCommand,
  groupBuyVoucherRegisterCommand,
  groupBuyVoucherRedeemCommand,
] as const);

export const MARKETING_EXTENSION_COMMAND_NAMES = Object.freeze([
  "marketing.referral.reward.issue",
  "marketing.group_buy.voucher.register",
  "marketing.group_buy.voucher.redeem",
] as const);

export type MarketingReferralRewardIssueInput = z.output<
  typeof MarketingReferralRewardIssueInputSchema
>;
export type MarketingReferralReward = z.output<typeof MarketingReferralRewardSchema>;
export type MarketingGroupBuyVoucherRegisterInput = z.output<
  typeof MarketingGroupBuyVoucherRegisterInputSchema
>;
export type MarketingGroupBuyVoucherRedeemInput = z.output<
  typeof MarketingGroupBuyVoucherRedeemInputSchema
>;
export type MarketingGroupBuyVoucher = z.output<typeof MarketingGroupBuyVoucherSchema>;
export type MarketingGroupBuyRedemption = z.output<typeof MarketingGroupBuyRedemptionSchema>;
