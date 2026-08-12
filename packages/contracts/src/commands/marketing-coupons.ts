import { z } from "zod";

import { ExactUtcTimestampSchema } from "../edge/primitives.js";
import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";

const PositiveVersionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const PositiveCountSchema = z.number().int().nonnegative().max(500);
const IssuedCountSchema = z.number().int().positive().max(500);
const MoneySchema = z.number().int().nonnegative().max(5_000_000);
const CouponRequirementSchema = z.number().int().nonnegative().max(2_500_000_000);
const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const ReasonSchema = z.string().trim().min(1).max(256);
const ReasonRedaction = Object.freeze([{ path: "/reason", strategy: "mask" as const }]);

export const MarketingCouponIssueAuthorityInputSchema = z.strictObject({
  campaign_id: z.uuid(),
  expected_version: PositiveVersionSchema,
  snapshot_id: z.uuid(),
  coupon_definition_id: z.uuid(),
});

export const MarketingCouponIssueInputSchema = MarketingCouponIssueAuthorityInputSchema.extend({
  reason: ReasonSchema,
});

export const MarketingCouponIssuePreviewSchema = z
  .strictObject({
    campaign_id: z.uuid(),
    campaign_version: PositiveVersionSchema,
    snapshot_id: z.uuid(),
    audience_digest: DigestSchema,
    coupon_definition_id: z.uuid(),
    coupon_version: PositiveVersionSchema,
    coupon_code: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u),
    coupon_name: z.string().trim().min(1).max(64),
    coupon_discount_cents: z.number().int().positive().max(5_000_000),
    coupon_min_order_cents: z.number().int().nonnegative().max(5_000_000),
    coupon_valid_days: z.number().int().min(1).max(3_650),
    audience_recipient_count: PositiveCountSchema,
    eligible_recipient_count: PositiveCountSchema,
    ineligible_recipient_count: PositiveCountSchema,
    budget_required_cents: CouponRequirementSchema,
    budget_remaining_cents: MoneySchema,
    evaluated_at: ExactUtcTimestampSchema,
  })
  .superRefine((value, context) => {
    if (
      value.eligible_recipient_count + value.ineligible_recipient_count !==
      value.audience_recipient_count
    ) {
      context.addIssue({
        code: "custom",
        path: ["eligible_recipient_count"],
        message: "invalid eligibility total",
      });
    }
    if (
      value.budget_required_cents !==
      value.coupon_discount_cents * value.eligible_recipient_count
    ) {
      context.addIssue({
        code: "custom",
        path: ["budget_required_cents"],
        message: "invalid coupon budget",
      });
    }
  });

export const MarketingCouponIssuePreviewResultSchema = z.strictObject({
  preview: MarketingCouponIssuePreviewSchema,
});

export const MarketingCouponBatchSchema = z
  .strictObject({
    batch_id: z.uuid(),
    campaign_id: z.uuid(),
    campaign_version: PositiveVersionSchema,
    snapshot_id: z.uuid(),
    audience_digest: DigestSchema,
    coupon_definition_id: z.uuid(),
    coupon_code: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u),
    coupon_discount_cents: z.number().int().positive().max(5_000_000),
    audience_recipient_count: IssuedCountSchema,
    eligible_recipient_count: IssuedCountSchema,
    granted_count: IssuedCountSchema,
    budget_committed_cents: MoneySchema,
    created_at: ExactUtcTimestampSchema,
    replayed: z.boolean(),
  })
  .superRefine((value, context) => {
    if (value.granted_count !== value.eligible_recipient_count) {
      context.addIssue({
        code: "custom",
        path: ["granted_count"],
        message: "incomplete coupon batch",
      });
    }
    if (value.budget_committed_cents !== value.coupon_discount_cents * value.granted_count) {
      context.addIssue({
        code: "custom",
        path: ["budget_committed_cents"],
        message: "invalid committed budget",
      });
    }
  });

export const MarketingCouponIssueResultSchema = z.strictObject({
  batch: MarketingCouponBatchSchema,
});

export const MarketingCouponBatchGetInputSchema = z.strictObject({ batch_id: z.uuid() });
export const MarketingCouponBatchGetResultSchema = z.strictObject({
  batch: MarketingCouponBatchSchema,
});

export const MarketingCouponRedemptionReverseInputSchema = z.strictObject({
  redemption_id: z.uuid(),
  reason: ReasonSchema,
});

export const MarketingCouponRedemptionReverseResultSchema = z.strictObject({
  reversal_id: z.uuid(),
  redemption_id: z.uuid(),
  grant_id: z.uuid(),
  order_id: z.uuid(),
  reversed_discount_cents: z.number().int().positive().max(5_000_000),
  changed: z.boolean(),
  at: ExactUtcTimestampSchema,
});

export const marketingCampaignCouponsIssueCommand: CommandDefinition<
  typeof MarketingCouponIssueInputSchema
> = defineCommand({
  name: "marketing.campaign.coupons.issue",
  version: "0.1.0",
  description: "Issue one bounded, server-qualified coupon batch from a frozen campaign audience.",
  description_llm:
    "R4 admin operation. Recipient identities, eligibility and budget are server-authoritative.",
  input: MarketingCouponIssueInputSchema,
  risk: "R4",
  invariants: [
    "rbac.marketing_manage",
    "marketing.feature_enabled",
    "marketing.audience_frozen_and_current",
    "marketing.coupon_budget_available",
  ],
  idempotent: true,
  sideEffects: [
    "marketing.coupon_batch_issued",
    "member.coupon_granted",
    "audit.marketing_coupon_batch_issued",
  ],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: ReasonRedaction,
  result_redaction: [],
});

export const marketingCouponRedemptionReverseCommand: CommandDefinition<
  typeof MarketingCouponRedemptionReverseInputSchema
> = defineCommand({
  name: "marketing.coupon.redemption.reverse",
  version: "0.1.0",
  description:
    "Append an audited reversal for one campaign coupon redemption and restore its order.",
  description_llm: "R4 admin correction. It never deletes or edits coupon ledger evidence.",
  input: MarketingCouponRedemptionReverseInputSchema,
  risk: "R4",
  invariants: [
    "rbac.marketing_manage",
    "marketing.feature_enabled",
    "marketing.coupon_redemption_active",
    "marketing.order_unpaid_and_open",
  ],
  idempotent: true,
  sideEffects: [
    "marketing.coupon_redemption_reversed",
    "order.discount_restored",
    "audit.marketing_coupon_redemption_reversed",
  ],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: ReasonRedaction,
  result_redaction: [],
});

function marketingCouponQuery<T extends z.ZodObject>(definition: {
  name: string;
  description: string;
  input: T;
}): QueryDefinition<T> {
  return defineQuery({
    name: definition.name,
    version: "0.1.0",
    description: definition.description,
    description_llm: "Admin-only aggregate coupon campaign evidence; excluded from AI tools.",
    input: definition.input,
    risk: "R2",
    invariants: ["rbac.marketing_manage"],
    idempotent: true,
    sideEffects: [],
    offline_mode: "denied",
    data_classification: "internal",
    input_redaction: [],
    result_redaction: [],
    max_result_rows: 1,
  });
}

export const marketingCampaignCouponsPreviewQuery = marketingCouponQuery({
  name: "marketing.campaign.coupons.preview",
  description:
    "Re-evaluate a frozen audience and return bounded coupon eligibility and budget totals.",
  input: MarketingCouponIssueAuthorityInputSchema,
});

export const marketingCampaignCouponBatchGetQuery = marketingCouponQuery({
  name: "marketing.campaign.coupon_batch.get",
  description: "Read one store-scoped coupon issuance batch without recipient identifiers.",
  input: MarketingCouponBatchGetInputSchema,
});

export const MARKETING_COUPON_COMMANDS = Object.freeze([
  marketingCampaignCouponsIssueCommand,
  marketingCouponRedemptionReverseCommand,
] as const);
export const MARKETING_COUPON_QUERIES = Object.freeze([
  marketingCampaignCouponsPreviewQuery,
  marketingCampaignCouponBatchGetQuery,
] as const);
export const MARKETING_COUPON_COMMAND_NAMES = Object.freeze([
  "marketing.campaign.coupons.issue",
  "marketing.coupon.redemption.reverse",
] as const);
export const MARKETING_COUPON_QUERY_NAMES = Object.freeze([
  "marketing.campaign.coupons.preview",
  "marketing.campaign.coupon_batch.get",
] as const);

export type MarketingCouponIssueAuthorityInput = z.output<
  typeof MarketingCouponIssueAuthorityInputSchema
>;
export type MarketingCouponIssueInput = z.output<typeof MarketingCouponIssueInputSchema>;
export type MarketingCouponIssuePreview = z.output<typeof MarketingCouponIssuePreviewSchema>;
export type MarketingCouponBatch = z.output<typeof MarketingCouponBatchSchema>;
export type MarketingCouponRedemptionReverseResult = z.output<
  typeof MarketingCouponRedemptionReverseResultSchema
>;
