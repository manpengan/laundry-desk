import { z } from "zod";

import { BusinessDateSchema } from "./stats.js";

const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const NonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const CodeSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/u);
const NameSchema = z.string().trim().min(1).max(64);
const StatusSchema = z.enum(["active", "retired"]);
const NoteSchema = z.string().max(256).nullable();

export const MemberTierDefinitionSchema = z.strictObject({
  definition_id: z.uuid(),
  code: CodeSchema,
  name: NameSchema,
  level: z.number().int().min(1).max(99),
  discount_bps: z.number().int().min(0).max(10_000),
  status: StatusSchema,
  version: PositiveSafeIntegerSchema,
  note: NoteSchema,
});

export const MemberPointsPolicySchema = z.strictObject({
  policy_id: z.uuid(),
  unit_cents: PositiveSafeIntegerSchema,
  points_per_unit: z.number().int().min(1).max(100_000),
  valid_days: z.number().int().min(1).max(3_650),
  status: StatusSchema,
  version: PositiveSafeIntegerSchema,
  note: NoteSchema,
});

export const MemberPunchTypeDefinitionSchema = z.strictObject({
  definition_id: z.uuid(),
  code: CodeSchema,
  name: NameSchema,
  total_uses: z.number().int().min(1).max(999),
  valid_days: z.number().int().min(1).max(3_650),
  status: StatusSchema,
  version: PositiveSafeIntegerSchema,
  note: NoteSchema,
});

export const MemberCouponTypeDefinitionSchema = z.strictObject({
  definition_id: z.uuid(),
  code: CodeSchema,
  name: NameSchema,
  discount_cents: PositiveSafeIntegerSchema,
  min_order_cents: NonNegativeSafeIntegerSchema,
  valid_days: z.number().int().min(1).max(3_650),
  status: StatusSchema,
  version: PositiveSafeIntegerSchema,
  note: NoteSchema,
});

export const MemberBenefitCatalogResultSchema = z.strictObject({
  tiers: z.array(MemberTierDefinitionSchema).max(50),
  points_policy: MemberPointsPolicySchema.nullable(),
  punch_types: z.array(MemberPunchTypeDefinitionSchema).max(50),
  coupon_types: z.array(MemberCouponTypeDefinitionSchema).max(50),
});

export const MemberMembershipViewSchema = z
  .strictObject({
    version: NonNegativeSafeIntegerSchema,
    tier: MemberTierDefinitionSchema.pick({
      definition_id: true,
      code: true,
      name: true,
      level: true,
      discount_bps: true,
    }).nullable(),
    valid_until: BusinessDateSchema.nullable(),
    status: z.enum(["unassigned", "active", "expired"]),
  })
  .superRefine((value, context) => {
    if ((value.tier === null) !== (value.valid_until === null)) {
      context.addIssue({ code: "custom", path: ["valid_until"], message: "Incomplete tier view" });
    }
    if ((value.status === "unassigned") !== (value.tier === null)) {
      context.addIssue({ code: "custom", path: ["status"], message: "Invalid tier status" });
    }
  });

export const MemberPointsLedgerViewSchema = z.strictObject({
  ledger_id: z.uuid(),
  kind: z.enum(["earn", "redeem"]),
  points_delta: z
    .number()
    .int()
    .min(-Number.MAX_SAFE_INTEGER)
    .max(Number.MAX_SAFE_INTEGER)
    .refine((value) => value !== 0, "Point ledger deltas must be non-zero"),
  order_id: z.uuid().nullable(),
  expires_on: BusinessDateSchema.nullable(),
  at: PositiveSafeIntegerSchema,
  note: NoteSchema,
});

export const MemberPointsViewSchema = z
  .strictObject({
    available_points: NonNegativeSafeIntegerSchema,
    lifetime_earned_points: NonNegativeSafeIntegerSchema,
    recent: z.array(MemberPointsLedgerViewSchema).max(50),
  })
  .superRefine((value, context) => {
    if (value.available_points > value.lifetime_earned_points) {
      context.addIssue({
        code: "custom",
        path: ["available_points"],
        message: "Available points cannot exceed lifetime earnings",
      });
    }
  });

export const MemberPunchCardViewSchema = z
  .strictObject({
    asset_id: z.uuid(),
    definition_id: z.uuid(),
    code: CodeSchema,
    name: NameSchema,
    total_uses: PositiveSafeIntegerSchema,
    used_uses: NonNegativeSafeIntegerSchema,
    remaining_uses: NonNegativeSafeIntegerSchema,
    issued_on: BusinessDateSchema,
    expires_on: BusinessDateSchema,
    status: z.enum(["active", "exhausted", "expired"]),
  })
  .superRefine((value, context) => {
    if (value.used_uses + value.remaining_uses !== value.total_uses) {
      context.addIssue({ code: "custom", path: ["remaining_uses"], message: "Invalid use total" });
    }
    if ((value.status === "exhausted") !== (value.remaining_uses === 0)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Only an exhausted card may have no remaining uses",
      });
    }
  });

export const MemberCouponGrantViewSchema = z
  .strictObject({
    asset_id: z.uuid(),
    definition_id: z.uuid(),
    code: CodeSchema,
    name: NameSchema,
    discount_cents: PositiveSafeIntegerSchema,
    min_order_cents: NonNegativeSafeIntegerSchema,
    granted_on: BusinessDateSchema,
    expires_on: BusinessDateSchema,
    status: z.enum(["active", "redeemed", "expired"]),
    redeemed_order_id: z.uuid().nullable(),
  })
  .superRefine((value, context) => {
    if ((value.status === "redeemed") !== (value.redeemed_order_id !== null)) {
      context.addIssue({
        code: "custom",
        path: ["redeemed_order_id"],
        message: "Only a redeemed coupon may cite an order",
      });
    }
  });

export const MemberBenefitsResultSchema = z.strictObject({
  account_id: z.uuid(),
  customer_id: z.uuid(),
  account_status: z.enum(["active", "frozen", "closed"]),
  membership: MemberMembershipViewSchema,
  points: MemberPointsViewSchema,
  punch_cards: z.array(MemberPunchCardViewSchema).max(50),
  coupons: z.array(MemberCouponGrantViewSchema).max(50),
});

export const MemberBenefitDefinitionUpsertResultSchema = z.strictObject({
  catalog: MemberBenefitCatalogResultSchema,
});

export const MemberBenefitMutationResultSchema = z.strictObject({
  benefits: MemberBenefitsResultSchema,
});

export type MemberBenefitCatalogResult = z.infer<typeof MemberBenefitCatalogResultSchema>;
export type MemberBenefitsResult = z.infer<typeof MemberBenefitsResultSchema>;
export type MemberBenefitDefinitionUpsertResult = z.infer<
  typeof MemberBenefitDefinitionUpsertResultSchema
>;
export type MemberBenefitMutationResult = z.infer<typeof MemberBenefitMutationResultSchema>;
