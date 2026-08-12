import {
  MarketingAudienceFreezeConfirmationSummarySchema,
  MarketingCampaignAudienceFreezeInputSchema,
  MarketingCampaignSetConfirmationSummarySchema,
  MarketingCampaignSetInputSchema,
  createCommandError,
  type MarketingAudienceFreezeConfirmationSummary,
  type MarketingCampaignSetConfirmationSummary,
} from "@laundry/contracts";

import type { HandlerContext } from "../bus/types.js";
import { HandlerCommandError } from "../bus/types.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import type { PendingActionPreparer } from "../handlers/default-chain-hooks.js";
import { createSqlFeaturesStore } from "../platform/features.js";
import type { MarketingHandlerDeps } from "./types.js";

function fail(
  code: "RESOURCE_UNAVAILABLE" | "PERMISSION_DENIED" | "INVARIANT_FAILED" | "POLICY_DENIED",
): never {
  throw new HandlerCommandError(createCommandError(code));
}

function currentTime(deps: MarketingHandlerDeps): Date {
  const value = deps.now?.() ?? new Date();
  if (!Number.isFinite(value.getTime())) fail("INVARIANT_FAILED");
  return value;
}

function transactionClient(context: Parameters<PendingActionPreparer>[1]) {
  if (context.transactionClient === undefined) fail("RESOURCE_UNAVAILABLE");
  return context.transactionClient;
}

async function authorize(
  deps: MarketingHandlerDeps,
  context: Parameters<PendingActionPreparer>[1],
): Promise<void> {
  if (context.actor.permissions?.includes("marketing_manage") !== true) {
    fail("PERMISSION_DENIED");
  }
  const client = transactionClient(context);
  const features =
    deps.persistence === "sql" ? createSqlFeaturesStore(client, context.tenant) : deps.features;
  if (!(await features.get(context.tenant.storeId)).marketing) fail("RESOURCE_UNAVAILABLE");
}

export function campaignSetConfirmationSummary(
  parsed: unknown,
): MarketingCampaignSetConfirmationSummary {
  const input = MarketingCampaignSetInputSchema.parse(parsed);
  return MarketingCampaignSetConfirmationSummarySchema.parse({
    kind: "marketing_campaign_set",
    ...input,
  });
}

async function audienceFreezeConfirmationSummary(
  deps: MarketingHandlerDeps,
  client: SqlClient,
  tenant: TenantContext,
  parsed: unknown,
): Promise<MarketingAudienceFreezeConfirmationSummary> {
  const input = MarketingCampaignAudienceFreezeInputSchema.parse(parsed);
  const evaluation = await deps.store.previewAudience(
    client,
    tenant,
    input.campaign_id,
    input.expected_version,
    currentTime(deps),
  );
  if (
    evaluation === null ||
    evaluation.audienceDigest !== input.preview_digest ||
    evaluation.recipientCount !== input.expected_recipient_count
  ) {
    fail("INVARIANT_FAILED");
  }
  return MarketingAudienceFreezeConfirmationSummarySchema.parse({
    kind: "marketing_audience_freeze",
    campaign_id: evaluation.campaign.campaignId,
    campaign_code: evaluation.campaign.code,
    campaign_name: evaluation.campaign.name,
    campaign_version: evaluation.campaign.version,
    audience_rule_sha256: evaluation.campaign.audienceRuleSha256,
    audience_digest: evaluation.audienceDigest,
    recipient_count: evaluation.recipientCount,
  });
}

export function createMarketingCampaignConfirmationPreparer(
  deps: MarketingHandlerDeps,
): PendingActionPreparer {
  return async (parsed, context) => {
    if (
      context.definition.name !== "marketing.campaign.set" &&
      context.definition.name !== "marketing.campaign.audience.freeze"
    ) {
      return null;
    }
    await authorize(deps, context);
    const summary =
      context.definition.name === "marketing.campaign.set"
        ? campaignSetConfirmationSummary(parsed)
        : await audienceFreezeConfirmationSummary(
            deps,
            transactionClient(context),
            context.tenant,
            parsed,
          );
    return Object.freeze({ authority: summary, summary });
  };
}

export async function requireFrozenMarketingCampaign(
  deps: MarketingHandlerDeps,
  context: HandlerContext,
  parsed: unknown,
): Promise<void> {
  if (context.request.confirmRef === undefined) return;
  const frozen =
    context.request.name === "marketing.campaign.set"
      ? MarketingCampaignSetConfirmationSummarySchema.safeParse(context.confirmationAuthority)
      : MarketingAudienceFreezeConfirmationSummarySchema.safeParse(context.confirmationAuthority);
  const expected =
    context.request.name === "marketing.campaign.set"
      ? campaignSetConfirmationSummary(parsed)
      : await audienceFreezeConfirmationSummary(deps, context.client, context.tenant, parsed);
  if (!frozen.success || JSON.stringify(frozen.data) !== JSON.stringify(expected)) {
    fail("POLICY_DENIED");
  }
}
