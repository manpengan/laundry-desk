import type { MarketingAudienceRule, MarketingCampaignSetInput } from "@laundry/contracts";

import type { SqlClient, TenantContext } from "../db/types.js";
import type { FeaturesStore } from "../platform/features.js";

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

export type MarketingSetResult =
  | Readonly<{ ok: true; before: MarketingCampaignRecord | null; after: MarketingCampaignRecord }>
  | Readonly<{ ok: false; reason: "missing" | "stale" | "terminal" | "conflict" }>;

export type MarketingFreezeResult =
  | Readonly<{ ok: true; snapshot: MarketingAudienceSnapshotRecord }>
  | Readonly<{ ok: false; reason: "missing" | "stale" | "preview_drift" }>;

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
}>;

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
