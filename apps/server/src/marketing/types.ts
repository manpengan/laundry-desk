import type {
  MarketingAudienceRule,
  MarketingCampaignSetInput,
  MarketingCouponBatch,
  MarketingCouponIssueAuthorityInput,
  MarketingCouponIssueInput,
  MarketingCouponIssuePreview,
  MarketingCouponIssueConfirmationSummary,
  MarketingCouponReversalConfirmationSummary,
} from "@laundry/contracts";

import type { SqlClient, TenantContext } from "../db/types.js";
import type { FeaturesStore } from "../platform/features.js";
import type { MarketingExtensionStore } from "./extension-types.js";

export type MarketingCampaignRecord = Readonly<{
  campaignId: string;
  code: string;
  name: string;
  status: "draft" | "scheduled" | "paused" | "cancelled";
  startsAt: Date;
  endsAt: Date;
  audienceRule: MarketingAudienceRule;
  audienceRuleSha256: string;
  recipientLimit: number;
  budgetLimitCents: number;
  budgetUsedCents: number;
  version: number;
  updatedAt: Date;
}>;

export type MarketingAudienceSnapshotRecord = Readonly<{
  snapshotId: string;
  campaignVersion: number;
  audienceRuleSha256: string;
  audienceDigest: string;
  recipientCount: number;
  createdAt: Date;
}>;

export type MarketingAudienceEvaluation = Readonly<{
  campaign: MarketingCampaignRecord;
  audienceDigest: string;
  recipientCount: number;
  matchedCount: number;
  evaluatedAt: Date;
}>;

export type MarketingAudienceSelection = MarketingAudienceEvaluation &
  Readonly<{ customerIds: readonly string[] }>;

export type MarketingSetResult =
  | Readonly<{ ok: true; before: MarketingCampaignRecord | null; after: MarketingCampaignRecord }>
  | Readonly<{ ok: false; reason: "missing" | "stale" | "terminal" | "conflict" }>;

export type MarketingFreezeResult =
  | Readonly<{ ok: true; snapshot: MarketingAudienceSnapshotRecord }>
  | Readonly<{ ok: false; reason: "missing" | "stale" | "preview_drift" }>;

export type MarketingCouponRejectReason =
  | "missing"
  | "stale"
  | "campaign_inactive"
  | "campaign_outside_window"
  | "snapshot_stale"
  | "audience_drift"
  | "coupon_missing"
  | "coupon_retired"
  | "eligibility_empty"
  | "budget_exceeded"
  | "redemption_missing"
  | "not_campaign_coupon"
  | "order_invalid"
  | "authority_drift";

export type MarketingCouponPreviewResult =
  | Readonly<{ ok: true; preview: MarketingCouponIssuePreview }>
  | Readonly<{ ok: false; reason: MarketingCouponRejectReason }>;

export type MarketingCouponBatchResult =
  | Readonly<{ ok: true; batch: MarketingCouponBatch }>
  | Readonly<{ ok: false; reason: MarketingCouponRejectReason }>;

export type MarketingCouponIssueStoreInput = MarketingCouponIssueInput &
  Readonly<{
    at: Date;
    frozenAuthority: MarketingCouponIssueConfirmationSummary;
  }>;

export type MarketingCouponReversalPreview = Readonly<{
  redemptionId: string;
  grantId: string;
  orderId: string;
  discountCents: number;
  alreadyReversed: boolean;
}>;

export type MarketingCouponReversalPreviewResult =
  | Readonly<{ ok: true; preview: MarketingCouponReversalPreview }>
  | Readonly<{ ok: false; reason: MarketingCouponRejectReason }>;

export type MarketingCouponReversalStoreInput = Readonly<{
  redemptionId: string;
  reason: string;
  at: Date;
  frozenAuthority: MarketingCouponReversalConfirmationSummary;
}>;

export type MarketingCouponReversalRecord = Readonly<{
  reversal_id: string;
  redemption_id: string;
  grant_id: string;
  order_id: string;
  reversed_discount_cents: number;
  changed: boolean;
  at: string;
}>;

export type MarketingCouponReversalResult =
  | Readonly<{ ok: true; reversal: MarketingCouponReversalRecord }>
  | Readonly<{ ok: false; reason: MarketingCouponRejectReason }>;

export type MarketingStore = Readonly<{
  setCampaign: (
    client: SqlClient,
    tenant: TenantContext,
    input: MarketingCampaignSetInput & Readonly<{ at: Date }>,
  ) => Promise<MarketingSetResult>;
  listCampaigns: (
    client: SqlClient,
    tenant: TenantContext,
    limit: number,
  ) => Promise<readonly MarketingCampaignRecord[]>;
  getCampaign: (
    client: SqlClient,
    tenant: TenantContext,
    campaignId: string,
  ) => Promise<Readonly<{
    campaign: MarketingCampaignRecord;
    snapshots: readonly MarketingAudienceSnapshotRecord[];
  }> | null>;
  previewAudience: (
    client: SqlClient,
    tenant: TenantContext,
    campaignId: string,
    expectedVersion: number,
    at: Date,
  ) => Promise<MarketingAudienceEvaluation | null>;
  freezeAudience: (
    client: SqlClient,
    tenant: TenantContext,
    input: Readonly<{
      campaignId: string;
      expectedVersion: number;
      previewDigest: string;
      expectedRecipientCount: number;
      at: Date;
    }>,
  ) => Promise<MarketingFreezeResult>;
  previewCouponIssue: (
    client: SqlClient,
    tenant: TenantContext,
    input: MarketingCouponIssueAuthorityInput & Readonly<{ at: Date }>,
  ) => Promise<MarketingCouponPreviewResult>;
  issueCoupons: (
    client: SqlClient,
    tenant: TenantContext,
    input: MarketingCouponIssueStoreInput,
  ) => Promise<MarketingCouponBatchResult>;
  getCouponBatch: (
    client: SqlClient,
    tenant: TenantContext,
    batchId: string,
  ) => Promise<MarketingCouponBatch | null>;
  previewCouponRedemptionReversal: (
    client: SqlClient,
    tenant: TenantContext,
    redemptionId: string,
  ) => Promise<MarketingCouponReversalPreviewResult>;
  reverseCouponRedemption: (
    client: SqlClient,
    tenant: TenantContext,
    input: MarketingCouponReversalStoreInput,
  ) => Promise<MarketingCouponReversalResult>;
}> &
  Partial<MarketingExtensionStore>;

export type MarketingHandlerDeps = Readonly<{
  store: MarketingStore;
  features: FeaturesStore;
  persistence?: "memory" | "sql";
  now?: () => Date;
}>;

export type MemoryAudienceCustomer = Readonly<{
  customerId: string;
  createdAt: Date;
  lastOrderAt: Date | null;
  activeMember: boolean;
  tierId: string | null;
  tierValidUntil: string | null;
}>;
