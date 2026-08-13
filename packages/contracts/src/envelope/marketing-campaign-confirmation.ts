import { z } from "zod";

import { ExactUtcTimestampSchema } from "../edge/primitives.js";
import { MarketingAudienceRuleSchema } from "../commands/marketing.js";

const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const CampaignCodeSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u);
const CampaignNameSchema = z.string().trim().min(1).max(64);

/** Complete public WYSIWYS authority for creating or updating one campaign. */
export const MarketingCampaignSetConfirmationSummarySchema = z.strictObject({
  kind: z.literal("marketing_campaign_set"),
  campaign_id: z.uuid().optional(),
  expected_version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  code: CampaignCodeSchema,
  name: CampaignNameSchema,
  status: z.enum(["draft", "scheduled", "paused", "cancelled"]),
  starts_at: ExactUtcTimestampSchema,
  ends_at: ExactUtcTimestampSchema,
  budget_limit_cents: z.number().int().positive().max(5_000_000),
  recipient_limit: z.number().int().positive().max(500),
  audience_rule: MarketingAudienceRuleSchema,
});

/** Digest-only server-resolved authority for freezing an evaluated audience. */
export const MarketingAudienceFreezeConfirmationSummarySchema = z.strictObject({
  kind: z.literal("marketing_audience_freeze"),
  campaign_id: z.uuid(),
  campaign_code: CampaignCodeSchema,
  campaign_name: CampaignNameSchema,
  campaign_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  audience_rule_sha256: DigestSchema,
  audience_digest: DigestSchema,
  recipient_count: z.number().int().nonnegative().max(500),
});

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type MarketingCampaignSetConfirmationSummary = DeepReadonly<
  z.output<typeof MarketingCampaignSetConfirmationSummarySchema>
>;
export type MarketingAudienceFreezeConfirmationSummary = DeepReadonly<
  z.output<typeof MarketingAudienceFreezeConfirmationSummarySchema>
>;
