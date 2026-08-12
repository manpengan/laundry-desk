import { z } from "zod";

import {
  defineCommand,
  defineQuery,
  type CommandDefinition,
  type QueryDefinition,
} from "../registry/definitions.js";
import { BusinessDateSchema } from "./stats.js";

const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const NonNegativeSafeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PositiveCentsSchema = PositiveSafeIntegerSchema.max(5_000_000);
const BenefitCodeSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_-]{0,31}$/u, "Expected a stable lowercase benefit code");
const BenefitNameSchema = z.string().trim().min(1).max(64);
const BenefitReasonSchema = z.string().trim().min(1).max(256);
const DefinitionStatusSchema = z.enum(["active", "retired"]);
const ValidDaysSchema = z.number().int().min(1).max(3_650);

const versionedDefinitionShape = {
  definition_id: z.uuid().optional(),
  expected_version: NonNegativeSafeIntegerSchema,
  code: BenefitCodeSchema,
  name: BenefitNameSchema,
  status: DefinitionStatusSchema,
  note: z.string().trim().max(256).optional(),
};

function requireDefinitionIdentity(
  value: Readonly<{ definition_id?: string | undefined; expected_version: number }>,
  context: z.RefinementCtx,
): void {
  if ((value.definition_id === undefined) !== (value.expected_version === 0)) {
    context.addIssue({
      code: "custom",
      path: ["expected_version"],
      message: "Create requires version 0; update requires an id and positive version",
    });
  }
}

const TierDefinitionInputSchema = z
  .strictObject({
    kind: z.literal("tier"),
    ...versionedDefinitionShape,
    level: z.number().int().min(1).max(99),
    discount_bps: z.number().int().min(0).max(10_000),
  })
  .superRefine(requireDefinitionIdentity);

const PointsPolicyDefinitionInputSchema = z.strictObject({
  kind: z.literal("points_policy"),
  expected_version: NonNegativeSafeIntegerSchema,
  unit_cents: PositiveCentsSchema,
  points_per_unit: z.number().int().min(1).max(100_000),
  valid_days: ValidDaysSchema,
  status: DefinitionStatusSchema,
  note: z.string().trim().max(256).optional(),
});

const PunchTypeDefinitionInputSchema = z
  .strictObject({
    kind: z.literal("punch_type"),
    ...versionedDefinitionShape,
    total_uses: z.number().int().min(1).max(999),
    valid_days: ValidDaysSchema,
  })
  .superRefine(requireDefinitionIdentity);

const CouponTypeDefinitionInputSchema = z
  .strictObject({
    kind: z.literal("coupon_type"),
    ...versionedDefinitionShape,
    discount_cents: PositiveCentsSchema,
    min_order_cents: NonNegativeSafeIntegerSchema.max(5_000_000),
    valid_days: ValidDaysSchema,
  })
  .superRefine(requireDefinitionIdentity);

export const MemberBenefitDefinitionSchema = z.discriminatedUnion("kind", [
  TierDefinitionInputSchema,
  PointsPolicyDefinitionInputSchema,
  PunchTypeDefinitionInputSchema,
  CouponTypeDefinitionInputSchema,
]);

export const MemberBenefitDefinitionUpsertInputSchema = z.strictObject({
  definition: MemberBenefitDefinitionSchema,
});

export const MemberMembershipSetInputSchema = z
  .strictObject({
    account_id: z.uuid(),
    expected_version: NonNegativeSafeIntegerSchema,
    tier_id: z.uuid().nullable(),
    valid_until: BusinessDateSchema.nullable(),
    reason: BenefitReasonSchema,
  })
  .superRefine((value, context) => {
    if ((value.tier_id === null) !== (value.valid_until === null)) {
      context.addIssue({
        code: "custom",
        path: ["valid_until"],
        message: "Tier and validity must either both be present or both be null",
      });
    }
  });

export const MemberPointsEarnInputSchema = z.strictObject({
  account_id: z.uuid(),
  order_id: z.uuid(),
});

export const MemberPointsRedeemInputSchema = z.strictObject({
  account_id: z.uuid(),
  points: z.number().int().min(1).max(1_000_000),
  reason: BenefitReasonSchema,
});

export const MemberAssetGrantInputSchema = z.strictObject({
  asset_kind: z.enum(["punch", "coupon"]),
  account_id: z.uuid(),
  definition_id: z.uuid(),
  reason: BenefitReasonSchema,
});

const PunchConsumeInputSchema = z.strictObject({
  asset_kind: z.literal("punch"),
  asset_id: z.uuid(),
  uses: z.number().int().min(1).max(100),
});

const CouponConsumeInputSchema = z.strictObject({
  asset_kind: z.literal("coupon"),
  asset_id: z.uuid(),
  order_id: z.uuid(),
});

export const MemberAssetConsumeSchema = z.discriminatedUnion("asset_kind", [
  PunchConsumeInputSchema,
  CouponConsumeInputSchema,
]);

export const MemberAssetConsumeInputSchema = z
  .strictObject({
    asset: MemberAssetConsumeSchema,
    reason: BenefitReasonSchema.optional(),
  })
  .superRefine((value, context) => {
    if ((value.asset.asset_kind === "punch") !== (value.reason !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Punch consumption requires a reason; coupon consumption must omit it",
      });
    }
  });

export const MemberBenefitCatalogGetInputSchema = z.strictObject({
  include_retired: z.boolean().optional(),
});

export const MemberBenefitsGetInputSchema = z.strictObject({
  customer_id: z.uuid(),
  include_expired: z.boolean().optional(),
});

const reasonRedaction = Object.freeze([{ path: "/reason", strategy: "mask" as const }]);

export const memberBenefitDefinitionUpsertCommand: CommandDefinition<
  typeof MemberBenefitDefinitionUpsertInputSchema
> = defineCommand({
  name: "member.benefit_definition.upsert",
  version: "1.0.0",
  description: "Create or version-update a membership tier, points policy, punch type or coupon.",
  description_llm:
    "Maintain one server-authoritative member benefit definition with optimistic versioning. Existing issued assets keep their frozen snapshots.",
  input: MemberBenefitDefinitionUpsertInputSchema,
  risk: "R3",
  invariants: ["rbac.member_rule_write", "member.definition_version"],
  idempotent: true,
  sideEffects: ["member.benefit_definition_changed", "audit.member_event"],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
});

export const memberMembershipSetCommand: CommandDefinition<typeof MemberMembershipSetInputSchema> =
  defineCommand({
    name: "member.membership.set",
    version: "1.0.0",
    description: "Assign, upgrade, extend or clear one virtual member tier.",
    description_llm:
      "Set an active account's tier and validity using the exact current membership version. This never expires or changes stored-value money.",
    input: MemberMembershipSetInputSchema,
    risk: "R3",
    invariants: [
      "rbac.member_lifecycle_manage",
      "member.account_active",
      "member.membership_version",
    ],
    idempotent: true,
    sideEffects: ["member.membership_changed", "audit.member_event"],
    offline_mode: "denied",
    data_classification: "internal",
    input_redaction: reasonRedaction,
    result_redaction: [],
  });

export const memberPointsEarnCommand: CommandDefinition<typeof MemberPointsEarnInputSchema> =
  defineCommand({
    name: "member.points.earn",
    version: "1.0.0",
    description: "Award server-calculated points for one fully settled closed order.",
    description_llm:
      "Award points once for the named account and order. The server checks customer ownership and computes points from the settled order and current policy; callers cannot submit a point amount.",
    input: MemberPointsEarnInputSchema,
    risk: "R2",
    invariants: [
      "rbac.order_write",
      "member.account_active",
      "member.points_policy_active",
      "member.order_closed_and_settled",
    ],
    idempotent: true,
    sideEffects: ["member.points_earned", "audit.member_event"],
    offline_mode: "denied",
    data_classification: "internal",
    input_redaction: [],
    result_redaction: [],
  });

export const memberPointsRedeemCommand: CommandDefinition<typeof MemberPointsRedeemInputSchema> =
  defineCommand({
    name: "member.points.redeem",
    version: "1.0.0",
    description: "Redeem available member points from earliest-expiring grants.",
    description_llm:
      "Redeem a positive point count from an active account. The server allocates only unexpired point grants and refuses the whole command when insufficient.",
    input: MemberPointsRedeemInputSchema,
    risk: "R3",
    invariants: ["rbac.order_write", "member.account_active", "member.points_sufficient"],
    idempotent: true,
    sideEffects: ["member.points_redeemed", "audit.member_event"],
    offline_mode: "denied",
    data_classification: "internal",
    input_redaction: reasonRedaction,
    result_redaction: [],
  });

export const memberAssetGrantCommand: CommandDefinition<typeof MemberAssetGrantInputSchema> =
  defineCommand({
    name: "member.asset.grant",
    version: "1.0.0",
    description: "Grant one version-frozen punch card or coupon to an active member account.",
    description_llm:
      "Issue an active punch-card or coupon definition to an active account. The server freezes its value, limits and expiry; retired definitions cannot be granted.",
    input: MemberAssetGrantInputSchema,
    risk: "R3",
    invariants: ["rbac.member_rule_write", "member.account_active", "member.definition_active"],
    idempotent: true,
    sideEffects: ["member.asset_granted", "audit.member_event"],
    offline_mode: "denied",
    data_classification: "internal",
    input_redaction: reasonRedaction,
    result_redaction: [],
  });

export const memberAssetConsumeCommand: CommandDefinition<typeof MemberAssetConsumeInputSchema> =
  defineCommand({
    name: "member.asset.consume",
    version: "1.0.0",
    description: "Consume punch uses or atomically redeem a fixed-value coupon on an unpaid order.",
    description_llm:
      "Consume an unexpired member asset online. Punch uses are append-only; coupon value is server-frozen and atomically updates the matching customer's unpaid order.",
    input: MemberAssetConsumeInputSchema,
    risk: "R2",
    invariants: [
      "rbac.order_write",
      "member.account_active",
      "member.asset_unexpired",
      "member.asset_balance_sufficient",
    ],
    idempotent: true,
    sideEffects: ["member.asset_consumed", "audit.member_event"],
    offline_mode: "denied",
    data_classification: "internal",
    input_redaction: reasonRedaction,
    result_redaction: [],
  });

export const memberBenefitCatalogGetQuery: QueryDefinition<
  typeof MemberBenefitCatalogGetInputSchema
> = defineQuery({
  name: "member.benefit_catalog.get",
  version: "1.0.0",
  description: "Read the bounded member benefit definition catalog.",
  description_llm:
    "Return membership tiers, the points policy, punch-card types and coupon types. No customer or asset data is included.",
  input: MemberBenefitCatalogGetInputSchema,
  risk: "R1",
  invariants: ["rbac.customer_read"],
  idempotent: true,
  sideEffects: [],
  offline_mode: "denied",
  data_classification: "internal",
  input_redaction: [],
  result_redaction: [],
  max_result_rows: 151,
});

export const memberBenefitsGetQuery: QueryDefinition<typeof MemberBenefitsGetInputSchema> =
  defineQuery({
    name: "member.benefits.get",
    version: "1.0.0",
    description: "Read one customer's tier, points, punch cards and coupons.",
    description_llm:
      "Return one existing member account's bounded virtual tier and benefit assets with server-derived expiry and remaining balances.",
    input: MemberBenefitsGetInputSchema,
    risk: "R1",
    invariants: ["rbac.customer_read"],
    idempotent: true,
    sideEffects: [],
    offline_mode: "denied",
    data_classification: "internal",
    input_redaction: [],
    result_redaction: [],
    max_result_rows: 151,
  });

export const MEMBER_BENEFIT_COMMANDS = Object.freeze([
  memberBenefitDefinitionUpsertCommand,
  memberMembershipSetCommand,
  memberPointsEarnCommand,
  memberPointsRedeemCommand,
  memberAssetGrantCommand,
  memberAssetConsumeCommand,
] as const);

export const MEMBER_BENEFIT_QUERIES = Object.freeze([
  memberBenefitCatalogGetQuery,
  memberBenefitsGetQuery,
] as const);

export const MEMBER_BENEFIT_COMMAND_NAMES = Object.freeze(
  MEMBER_BENEFIT_COMMANDS.map((definition) => definition.name),
);
export const MEMBER_BENEFIT_QUERY_NAMES = Object.freeze(
  MEMBER_BENEFIT_QUERIES.map((definition) => definition.name),
);

export type MemberBenefitDefinitionUpsertInput = z.infer<
  typeof MemberBenefitDefinitionUpsertInputSchema
>;
export type MemberMembershipSetInput = z.infer<typeof MemberMembershipSetInputSchema>;
export type MemberAssetGrantInput = z.infer<typeof MemberAssetGrantInputSchema>;
export type MemberAssetConsumeInput = z.infer<typeof MemberAssetConsumeInputSchema>;
