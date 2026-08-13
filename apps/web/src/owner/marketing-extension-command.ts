import type {
  MarketingGroupBuyRedemptionConfirmationSummary,
  MarketingGroupBuyRegistrationConfirmationSummary,
  MarketingGroupBuyVoucherRedeemInput,
  MarketingGroupBuyVoucherRegisterInput,
  MarketingReferralRewardConfirmationSummary,
  MarketingReferralRewardIssueInput,
} from "@laundry/contracts";

import type { SessionView } from "../auth/types.js";

export type MarketingExtensionAction =
  | "marketing.referral.reward.issue"
  | "marketing.group_buy.voucher.register"
  | "marketing.group_buy.voucher.redeem";

export type MarketingExtensionAttempt = Readonly<{
  generation: number;
  scopeKey: string;
  action: MarketingExtensionAction;
}>;

export type MarketingExtensionEpoch = MarketingExtensionAttempt &
  Readonly<{ authorityKey: string }>;

export function marketingSessionScopeKey(session: SessionView): string {
  const value = session.session;
  return JSON.stringify([
    value.session_id,
    value.session_version,
    value.org_id,
    value.store_id,
    value.staff_id,
    value.device_id,
    value.permission_version,
  ]);
}

export function marketingExtensionScopeKey(session: SessionView, context: string): string {
  return JSON.stringify([marketingSessionScopeKey(session), context]);
}

export function createMarketingExtensionAttempt(
  generation: number,
  scopeKey: string,
  action: MarketingExtensionAction,
): MarketingExtensionAttempt {
  return Object.freeze({ generation, scopeKey, action });
}

export function bindMarketingExtensionAuthority(
  attempt: MarketingExtensionAttempt,
  authorityKey: string,
): MarketingExtensionEpoch {
  return Object.freeze({ ...attempt, authorityKey });
}

export function marketingExtensionAttemptMatches(
  attempt: MarketingExtensionAttempt,
  generation: number,
  scopeKey: string,
  action: MarketingExtensionAction | null,
): boolean {
  return (
    attempt.generation === generation && attempt.scopeKey === scopeKey && attempt.action === action
  );
}

export function marketingExtensionEpochMatches(
  epoch: MarketingExtensionEpoch,
  generation: number,
  scopeKey: string,
  action: MarketingExtensionAction | null,
  authorityKey: string | null,
): boolean {
  return (
    marketingExtensionAttemptMatches(epoch, generation, scopeKey, action) &&
    epoch.authorityKey === authorityKey
  );
}

function authorityKey(
  scopeKey: string,
  action: MarketingExtensionAction,
  input: Readonly<Record<string, unknown>>,
): string {
  return JSON.stringify([scopeKey, action, input]);
}

export function marketingReferralAuthorityKey(
  scopeKey: string,
  input: MarketingReferralRewardIssueInput,
): string {
  return authorityKey(scopeKey, "marketing.referral.reward.issue", input);
}

export function marketingGroupBuyRegistrationAuthorityKey(
  scopeKey: string,
  input: MarketingGroupBuyVoucherRegisterInput,
): string {
  return authorityKey(scopeKey, "marketing.group_buy.voucher.register", input);
}

export function marketingGroupBuyRedemptionAuthorityKey(
  scopeKey: string,
  input: MarketingGroupBuyVoucherRedeemInput,
): string {
  return authorityKey(scopeKey, "marketing.group_buy.voucher.redeem", input);
}

export function marketingReferralSummaryMatches(
  summary: MarketingReferralRewardConfirmationSummary,
  input: MarketingReferralRewardIssueInput,
): boolean {
  return (
    summary.campaign_id === input.campaign_id &&
    summary.campaign_version === input.expected_version &&
    summary.referrer_customer_id === input.referrer_customer_id &&
    summary.referred_customer_id === input.referred_customer_id &&
    summary.qualifying_order_id === input.qualifying_order_id &&
    summary.coupon_definition_id === input.coupon_definition_id &&
    summary.reason === input.reason
  );
}

export function marketingGroupBuyRegistrationSummaryMatches(
  summary: MarketingGroupBuyRegistrationConfirmationSummary,
  input: MarketingGroupBuyVoucherRegisterInput,
): boolean {
  return (
    summary.code_last4 === input.voucher_code_last4 &&
    summary.provider === input.provider &&
    summary.external_order_ref === input.external_order_ref &&
    summary.label === input.label &&
    summary.face_value_cents === input.face_value_cents &&
    summary.expires_at === input.expires_at &&
    summary.reason === input.reason
  );
}

export function marketingGroupBuyRedemptionSummaryMatches(
  summary: MarketingGroupBuyRedemptionConfirmationSummary,
  input: MarketingGroupBuyVoucherRedeemInput,
  codeLast4: string,
): boolean {
  return (
    summary.code_last4 === codeLast4 &&
    summary.order_id === input.order_id &&
    summary.reason === input.reason
  );
}
