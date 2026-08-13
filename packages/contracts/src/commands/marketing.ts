import { z } from "zod";

import { ExactUtcTimestampSchema } from "../edge/primitives.js";
import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";

export const MARKETING_MAX_RECIPIENTS = 500;
export const MARKETING_MAX_BUDGET_CENTS = 5_000_000;

const PositiveVersionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const AgeAnySchema = z.strictObject({ kind: z.literal("any") });
const AgeWithinSchema = z.strictObject({
  kind: z.literal("within_days"),
  days: z.number().int().positive().max(3_650),
});
const ActivityAnySchema = z.strictObject({ kind: z.literal("any") });
const ActivityNoneSchema = z.strictObject({ kind: z.literal("none") });
const ActivityWithinSchema = z.strictObject({
  kind: z.literal("within_days"),
  days: z.number().int().positive().max(3_650),
});
const MembershipAnySchema = z.strictObject({ kind: z.literal("any") });
const MembershipMemberSchema = z.strictObject({ kind: z.literal("member") });
const MembershipNonMemberSchema = z.strictObject({ kind: z.literal("non_member") });
const MembershipTiersSchema = z.strictObject({
  kind: z.literal("tiers"),
  tier_ids: z
    .array(z.uuid())
    .min(1)
    .max(20)
    .refine((ids) => new Set(ids).size === ids.length, { message: "tier ids must be unique" }),
});

export const MarketingAudienceRuleSchema = z.strictObject({
  customer_age: z.discriminatedUnion("kind", [AgeAnySchema, AgeWithinSchema]),
  order_activity: z.discriminatedUnion("kind", [
    ActivityAnySchema,
    ActivityNoneSchema,
    ActivityWithinSchema,
  ]),
  membership: z.discriminatedUnion("kind", [
    MembershipAnySchema,
    MembershipMemberSchema,
    MembershipNonMemberSchema,
    MembershipTiersSchema,
  ]),
});

export const MarketingCampaignStatusSchema = z.enum(["draft", "scheduled", "paused", "cancelled"]);

const CampaignCodeSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u);
const CampaignNameSchema = z.string().trim().min(1).max(64);
const CampaignWindowSchema = z.strictObject({
  starts_at: ExactUtcTimestampSchema,
  ends_at: ExactUtcTimestampSchema,
});

function validWindow(value: z.output<typeof CampaignWindowSchema>): boolean {
  const start = Date.parse(value.starts_at);
  const end = Date.parse(value.ends_at);
  return end > start && end - start <= 730 * 24 * 60 * 60_000;
}

export const MarketingCampaignSetInputSchema = z
  .strictObject({
    campaign_id: z.uuid().optional(),
    expected_version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    code: CampaignCodeSchema,
    name: CampaignNameSchema,
    status: MarketingCampaignStatusSchema,
    starts_at: ExactUtcTimestampSchema,
    ends_at: ExactUtcTimestampSchema,
    budget_limit_cents: z.number().int().positive().max(MARKETING_MAX_BUDGET_CENTS),
    recipient_limit: z.number().int().positive().max(MARKETING_MAX_RECIPIENTS),
    audience_rule: MarketingAudienceRuleSchema,
  })
  .superRefine((value, context) => {
    if ((value.expected_version === 0) !== (value.campaign_id === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["expected_version"],
        message: "create uses version zero; update requires campaign id and positive version",
      });
    }
    if (!validWindow(value)) {
      context.addIssue({ code: "custom", path: ["ends_at"], message: "invalid campaign window" });
    }
  });

export const MarketingCampaignSchema = z.strictObject({
  campaign_id: z.uuid(),
  code: CampaignCodeSchema,
  name: CampaignNameSchema,
  status: MarketingCampaignStatusSchema,
  starts_at: ExactUtcTimestampSchema,
  ends_at: ExactUtcTimestampSchema,
  budget_limit_cents: z.number().int().positive().max(MARKETING_MAX_BUDGET_CENTS),
  budget_used_cents: z.number().int().nonnegative().max(MARKETING_MAX_BUDGET_CENTS),
  budget_remaining_cents: z.number().int().nonnegative().max(MARKETING_MAX_BUDGET_CENTS),
  recipient_limit: z.number().int().positive().max(MARKETING_MAX_RECIPIENTS),
  audience_rule: MarketingAudienceRuleSchema,
  audience_rule_sha256: DigestSchema,
  version: PositiveVersionSchema,
  updated_at: ExactUtcTimestampSchema,
});

export const MarketingCampaignSetResultSchema = z.strictObject({
  campaign: MarketingCampaignSchema,
});
export const MarketingCampaignsListInputSchema = z.strictObject({
  limit: z.number().int().positive().max(50).optional(),
});
export const MarketingCampaignsListResultSchema = z.strictObject({
  campaigns: z.array(MarketingCampaignSchema).max(50),
});
export const MarketingCampaignGetInputSchema = z.strictObject({ campaign_id: z.uuid() });
export const MarketingAudienceSnapshotSchema = z.strictObject({
  snapshot_id: z.uuid(),
  campaign_version: PositiveVersionSchema,
  audience_rule_sha256: DigestSchema,
  audience_digest: DigestSchema,
  recipient_count: z.number().int().nonnegative().max(MARKETING_MAX_RECIPIENTS),
  created_at: ExactUtcTimestampSchema,
});
export const MarketingCampaignGetResultSchema = z.strictObject({
  campaign: MarketingCampaignSchema,
  snapshots: z.array(MarketingAudienceSnapshotSchema).max(20),
});
export const MarketingCampaignAudiencePreviewInputSchema = z.strictObject({
  campaign_id: z.uuid(),
  expected_version: PositiveVersionSchema,
});
export const MarketingCampaignAudiencePreviewResultSchema = z.strictObject({
  campaign_id: z.uuid(),
  campaign_version: PositiveVersionSchema,
  audience_rule_sha256: DigestSchema,
  audience_digest: DigestSchema,
  recipient_count: z.number().int().nonnegative().max(MARKETING_MAX_RECIPIENTS),
  matched_count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  truncated: z.boolean(),
  evaluated_at: ExactUtcTimestampSchema,
});
export const MarketingCampaignAudienceFreezeInputSchema = z.strictObject({
  campaign_id: z.uuid(),
  expected_version: PositiveVersionSchema,
  preview_digest: DigestSchema,
  expected_recipient_count: z.number().int().nonnegative().max(MARKETING_MAX_RECIPIENTS),
});
export const MarketingCampaignAudienceFreezeResultSchema = z.strictObject({
  snapshot: MarketingAudienceSnapshotSchema,
});

export const marketingCampaignSetCommand: CommandDefinition<
  typeof MarketingCampaignSetInputSchema
> = defineCommand({
  name: "marketing.campaign.set",
  version: "0.1.0",
  description: "Create or update one store campaign with an audience rule, window and budget cap.",
  description_llm: "Admin-only metadata management. It never grants or sends a benefit.",
  input: MarketingCampaignSetInputSchema,
  risk: "R3",
  invariants: ["rbac.marketing_manage", "marketing.feature_enabled", "marketing.campaign_version"],
  idempotent: true,
  sideEffects: ["marketing.campaign_changed", "audit.marketing_campaign_changed"],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  size_measures: { amount: { kind: "field", path: "/budget_limit_cents" } },
  hard_limits: { max_amount_cents: MARKETING_MAX_BUDGET_CENTS },
  risk_escalation: { max_amount_cents: 500_000 },
});

export const marketingCampaignAudienceFreezeCommand: CommandDefinition<
  typeof MarketingCampaignAudienceFreezeInputSchema
> = defineCommand({
  name: "marketing.campaign.audience.freeze",
  version: "0.1.0",
  description: "Freeze a digest-only audience snapshot after re-evaluating its preview.",
  description_llm: "Admin-only WYSIWYS snapshot. No customer identifiers or coupons are returned.",
  input: MarketingCampaignAudienceFreezeInputSchema,
  risk: "R3",
  invariants: ["rbac.marketing_manage", "marketing.feature_enabled", "marketing.audience_current"],
  idempotent: true,
  sideEffects: ["marketing.audience_frozen", "audit.marketing_audience_frozen"],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
});

function marketingQuery<T extends z.ZodObject>(definition: {
  name: string;
  description: string;
  input: T;
  max: number;
}): QueryDefinition<T> {
  return defineQuery({
    name: definition.name,
    version: "0.1.0",
    description: definition.description,
    description_llm: "Admin-only aggregate campaign data; excluded from the AI projection.",
    input: definition.input,
    risk: "R2",
    invariants: ["rbac.marketing_manage"],
    idempotent: true,
    sideEffects: [],
    offline_mode: "denied",
    data_classification: "internal",
    input_redaction: [],
    result_redaction: [],
    max_result_rows: definition.max,
  });
}

export const marketingCampaignsListQuery = marketingQuery({
  name: "marketing.campaigns.list",
  description: "List up to 50 store-scoped campaign definitions with integer budget usage.",
  input: MarketingCampaignsListInputSchema,
  max: 50,
});
export const marketingCampaignGetQuery = marketingQuery({
  name: "marketing.campaign.get",
  description: "Read one campaign and at most 20 digest-only audience snapshots.",
  input: MarketingCampaignGetInputSchema,
  max: 20,
});
export const marketingCampaignAudiencePreviewQuery = marketingQuery({
  name: "marketing.campaign.audience.preview",
  description: "Evaluate a strict audience rule and return counts plus a customer-id digest only.",
  input: MarketingCampaignAudiencePreviewInputSchema,
  max: 1,
});

export const MARKETING_COMMANDS = Object.freeze([
  marketingCampaignSetCommand,
  marketingCampaignAudienceFreezeCommand,
] as const);
export const MARKETING_QUERIES = Object.freeze([
  marketingCampaignsListQuery,
  marketingCampaignGetQuery,
  marketingCampaignAudiencePreviewQuery,
] as const);
export const MARKETING_COMMAND_NAMES = Object.freeze([
  "marketing.campaign.set",
  "marketing.campaign.audience.freeze",
] as const);
export const MARKETING_QUERY_NAMES = Object.freeze([
  "marketing.campaigns.list",
  "marketing.campaign.get",
  "marketing.campaign.audience.preview",
] as const);

export type MarketingAudienceRule = z.output<typeof MarketingAudienceRuleSchema>;
export type MarketingCampaign = z.output<typeof MarketingCampaignSchema>;
export type MarketingCampaignSetInput = z.output<typeof MarketingCampaignSetInputSchema>;
export type MarketingAudienceSnapshot = z.output<typeof MarketingAudienceSnapshotSchema>;
