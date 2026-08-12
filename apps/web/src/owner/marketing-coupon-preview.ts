import type {
  MarketingCouponIssueConfirmationSummary,
  MarketingCouponIssuePreview,
  MarketingCouponReversalConfirmationSummary,
} from "@laundry/contracts";

export type MarketingCouponPreviewAuthority = Readonly<{
  campaign_id: string;
  expected_version: number;
  snapshot_id: string;
  coupon_definition_id: string;
}>;

export type MarketingCommandEpoch = Readonly<{
  generation: number;
  authorityKey: string;
}>;

export function marketingIssueAuthorityKey(
  authority: MarketingCouponPreviewAuthority | null,
  reason: string,
): string {
  return JSON.stringify([
    authority?.campaign_id ?? null,
    authority?.expected_version ?? null,
    authority?.snapshot_id ?? null,
    authority?.coupon_definition_id ?? null,
    reason,
  ]);
}

export function marketingReversalAuthorityKey(redemptionId: string, reason: string): string {
  return JSON.stringify([redemptionId, reason]);
}

export function createMarketingCommandEpoch(
  generation: number,
  authorityKey: string,
): MarketingCommandEpoch {
  return Object.freeze({ generation, authorityKey });
}

export function marketingCommandEpochMatches(
  request: MarketingCommandEpoch,
  currentGeneration: number,
  currentAuthorityKey: string,
): boolean {
  return request.generation === currentGeneration && request.authorityKey === currentAuthorityKey;
}

export function marketingIssueSummaryMatches(
  summary: MarketingCouponIssueConfirmationSummary,
  authority: MarketingCouponPreviewAuthority,
  reason: string,
): boolean {
  return (
    summary.campaign_id === authority.campaign_id &&
    summary.campaign_version === authority.expected_version &&
    summary.snapshot_id === authority.snapshot_id &&
    summary.coupon_definition_id === authority.coupon_definition_id &&
    summary.reason === reason
  );
}

export function marketingReversalSummaryMatches(
  summary: MarketingCouponReversalConfirmationSummary,
  redemptionId: string,
  reason: string,
): boolean {
  return summary.redemption_id === redemptionId && summary.reason === reason;
}

export function marketingCouponPreviewMatches(
  preview: MarketingCouponIssuePreview,
  authority: MarketingCouponPreviewAuthority,
): boolean {
  return (
    preview.campaign_id === authority.campaign_id &&
    preview.campaign_version === authority.expected_version &&
    preview.snapshot_id === authority.snapshot_id &&
    preview.coupon_definition_id === authority.coupon_definition_id
  );
}
