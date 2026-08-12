import { randomUUID } from "node:crypto";

import { MarketingAudienceRuleSchema } from "@laundry/contracts";

import { audienceDigest, evaluateMemoryAudience, sha256Canonical } from "./audience.js";
import type {
  MarketingAudienceSnapshotRecord,
  MarketingCampaignRecord,
  MarketingStore,
  MemoryAudienceCustomer,
} from "./types.js";

export type MemoryMarketingStoreOptions = Readonly<{
  customers?: readonly MemoryAudienceCustomer[];
  newId?: () => string;
}>;

function copyCampaign(
  input: Parameters<MarketingStore["setCampaign"]>[2],
  id: string,
  version: number,
  usedCents: number,
): MarketingCampaignRecord {
  const audienceRule = MarketingAudienceRuleSchema.parse(input.audience_rule);
  return Object.freeze({
    campaignId: id,
    code: input.code,
    name: input.name,
    status: input.status,
    startsAt: new Date(input.starts_at),
    endsAt: new Date(input.ends_at),
    audienceRule,
    audienceRuleSha256: sha256Canonical(audienceRule),
    recipientLimit: input.recipient_limit,
    budgetLimitCents: input.budget_limit_cents,
    budgetUsedCents: usedCents,
    version,
    updatedAt: new Date(input.at),
  });
}

export function createMemoryMarketingStore(
  options: MemoryMarketingStoreOptions = {},
): MarketingStore {
  const customers = Object.freeze([...(options.customers ?? [])]);
  const newId = options.newId ?? randomUUID;
  let campaigns = new Map<string, MarketingCampaignRecord>();
  let snapshots = new Map<string, readonly MarketingAudienceSnapshotRecord[]>();

  const preview = (campaign: MarketingCampaignRecord, expectedVersion: number, at: Date) => {
    if (campaign.version !== expectedVersion) return null;
    const selection = evaluateMemoryAudience(
      customers,
      campaign.audienceRule,
      campaign.recipientLimit,
      at,
    );
    return Object.freeze({
      campaign,
      audienceDigest: audienceDigest(
        campaign.campaignId,
        campaign.version,
        campaign.audienceRuleSha256,
        selection.customerIds,
      ),
      recipientCount: selection.customerIds.length,
      matchedCount: selection.matchedCount,
      evaluatedAt: new Date(at),
    });
  };

  return Object.freeze({
    async setCampaign(_client, _tenant, input) {
      const id = input.campaign_id ?? newId();
      const before = campaigns.get(id) ?? null;
      if (input.expected_version === 0) {
        if (
          before !== null ||
          [...campaigns.values()].some((campaign) => campaign.code === input.code)
        ) {
          return Object.freeze({ ok: false as const, reason: "conflict" as const });
        }
      } else if (before === null) {
        return Object.freeze({ ok: false as const, reason: "missing" as const });
      } else if (before.version !== input.expected_version) {
        return Object.freeze({ ok: false as const, reason: "stale" as const });
      } else if (before.status === "cancelled" || input.at >= before.endsAt) {
        return Object.freeze({ ok: false as const, reason: "terminal" as const });
      } else if (input.code !== before.code) {
        return Object.freeze({ ok: false as const, reason: "conflict" as const });
      }
      const after = copyCampaign(
        input,
        id,
        (before?.version ?? 0) + 1,
        before?.budgetUsedCents ?? 0,
      );
      const next = new Map(campaigns);
      next.set(id, after);
      campaigns = next;
      return Object.freeze({ ok: true as const, before, after });
    },
    async listCampaigns(_client, _tenant, limit) {
      return Object.freeze(
        [...campaigns.values()]
          .sort(
            (left, right) =>
              right.updatedAt.getTime() - left.updatedAt.getTime() ||
              left.campaignId.localeCompare(right.campaignId),
          )
          .slice(0, limit),
      );
    },
    async getCampaign(_client, _tenant, campaignId) {
      const campaign = campaigns.get(campaignId);
      if (campaign === undefined) return null;
      return Object.freeze({
        campaign,
        snapshots: Object.freeze([...(snapshots.get(campaignId) ?? [])].slice(0, 20)),
      });
    },
    async previewAudience(_client, _tenant, campaignId, expectedVersion, at) {
      const campaign = campaigns.get(campaignId);
      return campaign === undefined ? null : preview(campaign, expectedVersion, at);
    },
    async freezeAudience(_client, _tenant, input) {
      const campaign = campaigns.get(input.campaignId);
      if (campaign === undefined) {
        return Object.freeze({ ok: false as const, reason: "missing" as const });
      }
      const evaluated = preview(campaign, input.expectedVersion, input.at);
      if (evaluated === null) {
        return Object.freeze({ ok: false as const, reason: "stale" as const });
      }
      if (
        evaluated.audienceDigest !== input.previewDigest ||
        evaluated.recipientCount !== input.expectedRecipientCount
      ) {
        return Object.freeze({ ok: false as const, reason: "preview_drift" as const });
      }
      const existing = (snapshots.get(input.campaignId) ?? []).find(
        (snapshot) =>
          snapshot.campaignVersion === campaign.version &&
          snapshot.audienceDigest === evaluated.audienceDigest,
      );
      if (existing !== undefined) return Object.freeze({ ok: true as const, snapshot: existing });
      const snapshot = Object.freeze({
        snapshotId: newId(),
        campaignVersion: campaign.version,
        audienceRuleSha256: campaign.audienceRuleSha256,
        audienceDigest: evaluated.audienceDigest,
        recipientCount: evaluated.recipientCount,
        createdAt: new Date(input.at),
      });
      const next = new Map(snapshots);
      next.set(
        input.campaignId,
        Object.freeze([snapshot, ...(snapshots.get(input.campaignId) ?? [])]),
      );
      snapshots = next;
      return Object.freeze({ ok: true as const, snapshot });
    },
  });
}
