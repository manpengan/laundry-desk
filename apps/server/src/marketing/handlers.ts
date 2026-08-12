import {
  MarketingCampaignAudienceFreezeInputSchema,
  MarketingCampaignAudienceFreezeResultSchema,
  MarketingCampaignAudiencePreviewInputSchema,
  MarketingCampaignAudiencePreviewResultSchema,
  MarketingCampaignGetInputSchema,
  MarketingCampaignGetResultSchema,
  MarketingCampaignSetInputSchema,
  MarketingCampaignSetResultSchema,
  MarketingCampaignsListInputSchema,
  MarketingCampaignsListResultSchema,
  createCommandError,
} from "@laundry/contracts";

import type { CommandHandler, HandlerContext, HandlerOutcome } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import { createSqlFeaturesStore } from "../platform/features.js";
import { requireFrozenMarketingCampaign } from "./confirmation.js";
import { createMarketingCouponHandlers } from "./coupon-handlers.js";
import type {
  MarketingAudienceEvaluation,
  MarketingAudienceSnapshotRecord,
  MarketingCampaignRecord,
  MarketingHandlerDeps,
} from "./types.js";

const HANDLER_NAMES = [
  "marketing.campaign.set",
  "marketing.campaign.audience.freeze",
  "marketing.campaigns.list",
  "marketing.campaign.get",
  "marketing.campaign.audience.preview",
  "marketing.campaign.coupons.preview",
  "marketing.campaign.coupons.issue",
  "marketing.campaign.coupon_batch.get",
  "marketing.coupon.redemption.reverse",
] as const;

function error(
  code: "RESOURCE_UNAVAILABLE" | "PERMISSION_DENIED" | "INVARIANT_FAILED" | "IDEMPOTENCY_CONFLICT",
): never {
  throw new HandlerCommandError(createCommandError(code));
}

async function authorize(deps: MarketingHandlerDeps, context: HandlerContext): Promise<void> {
  if (context.actor.permissions?.includes("marketing_manage") !== true) error("PERMISSION_DENIED");
  const features =
    deps.persistence === "sql"
      ? createSqlFeaturesStore(context.client, context.tenant)
      : deps.features;
  if (!(await features.get(context.tenant.storeId)).marketing) error("RESOURCE_UNAVAILABLE");
}

function now(deps: MarketingHandlerDeps): Date {
  const value = deps.now?.() ?? new Date();
  if (!Number.isFinite(value.getTime())) error("INVARIANT_FAILED");
  return value;
}

function wireCampaign(value: MarketingCampaignRecord) {
  return Object.freeze({
    campaign_id: value.campaignId,
    code: value.code,
    name: value.name,
    status: value.status,
    starts_at: value.startsAt.toISOString(),
    ends_at: value.endsAt.toISOString(),
    budget_limit_cents: value.budgetLimitCents,
    budget_used_cents: value.budgetUsedCents,
    budget_remaining_cents: value.budgetLimitCents - value.budgetUsedCents,
    recipient_limit: value.recipientLimit,
    audience_rule: value.audienceRule,
    audience_rule_sha256: value.audienceRuleSha256,
    version: value.version,
    updated_at: value.updatedAt.toISOString(),
  });
}

function wireSnapshot(value: MarketingAudienceSnapshotRecord) {
  return Object.freeze({
    snapshot_id: value.snapshotId,
    campaign_version: value.campaignVersion,
    audience_rule_sha256: value.audienceRuleSha256,
    audience_digest: value.audienceDigest,
    recipient_count: value.recipientCount,
    created_at: value.createdAt.toISOString(),
  });
}

function wirePreview(value: MarketingAudienceEvaluation) {
  return Object.freeze({
    campaign_id: value.campaign.campaignId,
    campaign_version: value.campaign.version,
    audience_rule_sha256: value.campaign.audienceRuleSha256,
    audience_digest: value.audienceDigest,
    recipient_count: value.recipientCount,
    matched_count: value.matchedCount,
    truncated: value.matchedCount > value.recipientCount,
    evaluated_at: value.evaluatedAt.toISOString(),
  });
}

function setHandler(deps: MarketingHandlerDeps): CommandHandler {
  return async (context): Promise<HandlerOutcome> => {
    await authorize(deps, context);
    const input = MarketingCampaignSetInputSchema.parse(context.parsed);
    await requireFrozenMarketingCampaign(deps, context, input);
    const changed = await deps.store.setCampaign(context.client, context.tenant, {
      ...input,
      at: now(deps),
    });
    if (!changed.ok) {
      error(
        changed.reason === "stale" || changed.reason === "conflict"
          ? "IDEMPOTENCY_CONFLICT"
          : "INVARIANT_FAILED",
      );
    }
    const result = MarketingCampaignSetResultSchema.parse({
      campaign: wireCampaign(changed.after),
    });
    return Object.freeze({
      result,
      audit: Object.freeze({
        entity: "marketing_campaign",
        entityId: changed.after.campaignId,
        ...(changed.before === null
          ? {}
          : {
              beforeJson: JSON.stringify({
                version: changed.before.version,
                status: changed.before.status,
                audience_rule_sha256: changed.before.audienceRuleSha256,
                budget_limit_cents: changed.before.budgetLimitCents,
              }),
            }),
        afterJson: JSON.stringify({
          version: changed.after.version,
          status: changed.after.status,
          audience_rule_sha256: changed.after.audienceRuleSha256,
          budget_limit_cents: changed.after.budgetLimitCents,
          recipient_limit: changed.after.recipientLimit,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "marketing.campaign_changed",
          payload: Object.freeze({
            campaign_id: changed.after.campaignId,
            version: changed.after.version,
          }),
        }),
      ]),
    });
  };
}

function listHandler(deps: MarketingHandlerDeps): CommandHandler {
  return async (context): Promise<HandlerOutcome> => {
    await authorize(deps, context);
    const input = MarketingCampaignsListInputSchema.parse(context.parsed);
    const campaigns = await deps.store.listCampaigns(
      context.client,
      context.tenant,
      input.limit ?? 50,
    );
    return Object.freeze({
      result: MarketingCampaignsListResultSchema.parse({ campaigns: campaigns.map(wireCampaign) }),
    });
  };
}

function getHandler(deps: MarketingHandlerDeps): CommandHandler {
  return async (context): Promise<HandlerOutcome> => {
    await authorize(deps, context);
    const input = MarketingCampaignGetInputSchema.parse(context.parsed);
    const value = await deps.store.getCampaign(context.client, context.tenant, input.campaign_id);
    if (value === null) error("INVARIANT_FAILED");
    return Object.freeze({
      result: MarketingCampaignGetResultSchema.parse({
        campaign: wireCampaign(value.campaign),
        snapshots: value.snapshots.map(wireSnapshot),
      }),
    });
  };
}

function previewHandler(deps: MarketingHandlerDeps): CommandHandler {
  return async (context): Promise<HandlerOutcome> => {
    await authorize(deps, context);
    const input = MarketingCampaignAudiencePreviewInputSchema.parse(context.parsed);
    const value = await deps.store.previewAudience(
      context.client,
      context.tenant,
      input.campaign_id,
      input.expected_version,
      now(deps),
    );
    if (value === null) error("INVARIANT_FAILED");
    return Object.freeze({
      result: MarketingCampaignAudiencePreviewResultSchema.parse(wirePreview(value)),
    });
  };
}

function freezeHandler(deps: MarketingHandlerDeps): CommandHandler {
  return async (context): Promise<HandlerOutcome> => {
    await authorize(deps, context);
    const input = MarketingCampaignAudienceFreezeInputSchema.parse(context.parsed);
    await requireFrozenMarketingCampaign(deps, context, input);
    const frozen = await deps.store.freezeAudience(context.client, context.tenant, {
      campaignId: input.campaign_id,
      expectedVersion: input.expected_version,
      previewDigest: input.preview_digest,
      expectedRecipientCount: input.expected_recipient_count,
      at: now(deps),
    });
    if (!frozen.ok) error(frozen.reason === "stale" ? "IDEMPOTENCY_CONFLICT" : "INVARIANT_FAILED");
    const result = MarketingCampaignAudienceFreezeResultSchema.parse({
      snapshot: wireSnapshot(frozen.snapshot),
    });
    return Object.freeze({
      result,
      audit: Object.freeze({
        entity: "marketing_audience_snapshot",
        entityId: frozen.snapshot.snapshotId,
        afterJson: JSON.stringify({
          campaign_id: input.campaign_id,
          campaign_version: frozen.snapshot.campaignVersion,
          audience_rule_sha256: frozen.snapshot.audienceRuleSha256,
          audience_digest: frozen.snapshot.audienceDigest,
          recipient_count: frozen.snapshot.recipientCount,
        }),
      }),
      events: Object.freeze([
        Object.freeze({
          type: "marketing.audience_frozen",
          payload: Object.freeze({
            campaign_id: input.campaign_id,
            snapshot_id: frozen.snapshot.snapshotId,
          }),
        }),
      ]),
    });
  };
}

export function createMarketingHandlers(
  deps: MarketingHandlerDeps,
): Readonly<Record<(typeof HANDLER_NAMES)[number], CommandHandler>> {
  const coupons = createMarketingCouponHandlers(deps);
  return Object.freeze({
    "marketing.campaign.coupons.preview": coupons["marketing.campaign.coupons.preview"]!,
    "marketing.campaign.coupons.issue": coupons["marketing.campaign.coupons.issue"]!,
    "marketing.campaign.coupon_batch.get": coupons["marketing.campaign.coupon_batch.get"]!,
    "marketing.coupon.redemption.reverse": coupons["marketing.coupon.redemption.reverse"]!,
    "marketing.campaign.set": setHandler(deps),
    "marketing.campaign.audience.freeze": freezeHandler(deps),
    "marketing.campaigns.list": listHandler(deps),
    "marketing.campaign.get": getHandler(deps),
    "marketing.campaign.audience.preview": previewHandler(deps),
  });
}
