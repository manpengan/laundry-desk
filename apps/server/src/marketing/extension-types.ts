import type {
  MarketingGroupBuyRedemption,
  MarketingGroupBuyRedemptionAuthority,
  MarketingGroupBuyRegistrationAuthority,
  MarketingGroupBuyVoucher,
  MarketingGroupBuyVoucherRedeemInput,
  MarketingGroupBuyVoucherRegisterInput,
  MarketingReferralReward,
  MarketingReferralRewardAuthority,
  MarketingReferralRewardIssueInput,
} from "@laundry/contracts";

import type { SqlClient, TenantContext } from "../db/types.js";

export type MarketingExtensionRejectReason =
  | "missing"
  | "stale"
  | "campaign_inactive"
  | "campaign_outside_window"
  | "customer_invalid"
  | "self_referral"
  | "account_invalid"
  | "order_invalid"
  | "coupon_missing"
  | "coupon_retired"
  | "already_rewarded"
  | "budget_exceeded"
  | "voucher_conflict"
  | "voucher_expired"
  | "voucher_redeemed"
  | "authority_drift";

export type MarketingReferralAuthorityResult =
  | Readonly<{ ok: true; authority: MarketingReferralRewardAuthority }>
  | Readonly<{ ok: false; reason: MarketingExtensionRejectReason }>;

export type MarketingReferralRewardResult =
  | Readonly<{ ok: true; reward: MarketingReferralReward }>
  | Readonly<{ ok: false; reason: MarketingExtensionRejectReason }>;

export type MarketingGroupBuyRegistrationAuthorityResult =
  | Readonly<{ ok: true; authority: MarketingGroupBuyRegistrationAuthority }>
  | Readonly<{ ok: false; reason: MarketingExtensionRejectReason }>;

export type MarketingGroupBuyRegistrationResult =
  | Readonly<{ ok: true; voucher: MarketingGroupBuyVoucher }>
  | Readonly<{ ok: false; reason: MarketingExtensionRejectReason }>;

export type MarketingGroupBuyRedemptionAuthorityResult =
  | Readonly<{ ok: true; authority: MarketingGroupBuyRedemptionAuthority }>
  | Readonly<{ ok: false; reason: MarketingExtensionRejectReason }>;

export type MarketingGroupBuyRedemptionResult =
  | Readonly<{ ok: true; redemption: MarketingGroupBuyRedemption }>
  | Readonly<{ ok: false; reason: MarketingExtensionRejectReason }>;

export type MarketingExtensionStore = Readonly<{
  previewReferralReward: (
    client: SqlClient,
    tenant: TenantContext,
    input: MarketingReferralRewardIssueInput & Readonly<{ at: Date }>,
  ) => Promise<MarketingReferralAuthorityResult>;
  issueReferralReward: (
    client: SqlClient,
    tenant: TenantContext,
    input: MarketingReferralRewardIssueInput &
      Readonly<{ at: Date; frozenAuthority: MarketingReferralRewardAuthority }>,
  ) => Promise<MarketingReferralRewardResult>;
  previewGroupBuyRegistration: (
    client: SqlClient,
    tenant: TenantContext,
    input: MarketingGroupBuyVoucherRegisterInput & Readonly<{ at: Date }>,
  ) => Promise<MarketingGroupBuyRegistrationAuthorityResult>;
  registerGroupBuyVoucher: (
    client: SqlClient,
    tenant: TenantContext,
    input: MarketingGroupBuyVoucherRegisterInput &
      Readonly<{
        at: Date;
        frozenAuthority: MarketingGroupBuyRegistrationAuthority;
      }>,
  ) => Promise<MarketingGroupBuyRegistrationResult>;
  previewGroupBuyRedemption: (
    client: SqlClient,
    tenant: TenantContext,
    input: MarketingGroupBuyVoucherRedeemInput & Readonly<{ at: Date }>,
  ) => Promise<MarketingGroupBuyRedemptionAuthorityResult>;
  redeemGroupBuyVoucher: (
    client: SqlClient,
    tenant: TenantContext,
    input: MarketingGroupBuyVoucherRedeemInput &
      Readonly<{ at: Date; frozenAuthority: MarketingGroupBuyRedemptionAuthority }>,
  ) => Promise<MarketingGroupBuyRedemptionResult>;
}>;
