import { z } from "zod";

const CountSchema = z.number().int().nonnegative().max(500);
const MoneySchema = z.number().int().nonnegative().max(2_500_000_000);
const ReasonSchema = z.string().trim().min(1).max(256);

/** Public WYSIWYS snapshot resolved by the server before an R4 coupon issue. */
export const MarketingCouponIssueConfirmationSummarySchema = z
  .strictObject({
    kind: z.literal("marketing_coupon_issue"),
    campaign_id: z.uuid(),
    campaign_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    snapshot_id: z.uuid(),
    audience_digest: z.string().regex(/^[0-9a-f]{64}$/u),
    coupon_definition_id: z.uuid(),
    coupon_version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    coupon_code: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u),
    coupon_name: z.string().trim().min(1).max(64),
    coupon_discount_cents: z.number().int().positive().max(5_000_000),
    coupon_min_order_cents: z.number().int().nonnegative().max(5_000_000),
    coupon_valid_days: z.number().int().min(1).max(3_650),
    audience_recipient_count: CountSchema,
    eligible_recipient_count: CountSchema,
    ineligible_recipient_count: CountSchema,
    budget_required_cents: MoneySchema,
    budget_remaining_cents: MoneySchema,
    reason: ReasonSchema,
  })
  .superRefine((value, context) => {
    if (
      value.eligible_recipient_count + value.ineligible_recipient_count !==
      value.audience_recipient_count
    ) {
      context.addIssue({
        code: "custom",
        path: ["eligible_recipient_count"],
        message: "invalid frozen eligibility total",
      });
    }
    if (
      value.budget_required_cents !==
      value.coupon_discount_cents * value.eligible_recipient_count
    ) {
      context.addIssue({
        code: "custom",
        path: ["budget_required_cents"],
        message: "invalid frozen coupon budget",
      });
    }
  });

/** Public WYSIWYS snapshot resolved by the server before an R4 redemption reversal. */
export const MarketingCouponReversalConfirmationSummarySchema = z.strictObject({
  kind: z.literal("marketing_coupon_redemption_reversal"),
  redemption_id: z.uuid(),
  grant_id: z.uuid(),
  order_id: z.uuid(),
  reversed_discount_cents: z.number().int().positive().max(5_000_000),
  already_reversed: z.boolean(),
  reason: ReasonSchema,
});

type DeepReadonly<T> = T extends readonly (infer Item)[]
  ? readonly DeepReadonly<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
    : T;

export type MarketingCouponIssueConfirmationSummary = DeepReadonly<
  z.output<typeof MarketingCouponIssueConfirmationSummarySchema>
>;
export type MarketingCouponReversalConfirmationSummary = DeepReadonly<
  z.output<typeof MarketingCouponReversalConfirmationSummarySchema>
>;
