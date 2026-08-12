import {
  MemberBenefitCatalogResultSchema,
  MemberBenefitDefinitionUpsertInputSchema,
  MemberBenefitMutationResultSchema,
  MemberBenefitsResultSchema,
  MemberMembershipSetInputSchema,
  MemberPointsRedeemInputSchema,
  MemberAssetGrantInputSchema,
  MemberAssetConsumeInputSchema,
  type MemberBenefitCatalogResult,
  type MemberBenefitDefinitionUpsertInput,
  type MemberBenefitMutationResult,
  type MemberBenefitsResult,
} from "@laundry/contracts";

import { unwrapQueryResult } from "./customer-model.js";
import { yuanAmountToCents } from "./member-model.js";
import { centsToYuanInput } from "./member-model.js";

export type MemberBenefitCatalogView = Readonly<MemberBenefitCatalogResult>;
export type MemberBenefitsView = Readonly<MemberBenefitsResult>;
export type MemberBenefitMutationView = Readonly<MemberBenefitMutationResult>;
export type MemberBenefitDefinitionInput = MemberBenefitDefinitionUpsertInput["definition"];

export type BenefitDefinitionKind = MemberBenefitDefinitionInput["kind"];

export type BenefitCatalogDefinition =
  | (MemberBenefitCatalogResult["tiers"][number] & Readonly<{ kind: "tier" }>)
  | (NonNullable<MemberBenefitCatalogResult["points_policy"]> & Readonly<{ kind: "points_policy" }>)
  | (MemberBenefitCatalogResult["punch_types"][number] & Readonly<{ kind: "punch_type" }>)
  | (MemberBenefitCatalogResult["coupon_types"][number] & Readonly<{ kind: "coupon_type" }>);

export type BenefitDefinitionDraft = Readonly<{
  kind: BenefitDefinitionKind;
  definitionId: string | null;
  expectedVersion: number;
  code: string;
  name: string;
  primary: string;
  secondary: string;
  validDays: string;
  note: string;
}>;

export const EMPTY_BENEFIT_DEFINITION_DRAFT: BenefitDefinitionDraft = Object.freeze({
  kind: "tier",
  definitionId: null,
  expectedVersion: 0,
  code: "",
  name: "",
  primary: "",
  secondary: "0",
  validDays: "",
  note: "",
});

function positiveInteger(value: string, max: number): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : null;
}

function nonNegativeYuan(value: string): number | null {
  if (value.trim() === "0" || value.trim() === "0.0" || value.trim() === "0.00") return 0;
  return yuanAmountToCents(value);
}

function basisPointPercent(value: string): number | null {
  const trimmed = value.trim();
  if (!/^(?:100(?:\.0{1,2})?|\d{1,2}(?:\.\d{1,2})?)$/u.test(trimmed)) return null;
  const bps = Math.round(Number(trimmed) * 100);
  return Number.isSafeInteger(bps) && bps >= 0 && bps <= 10_000 ? bps : null;
}

export function formatBenefitDiscountPercent(bps: number): string {
  return (bps / 100)
    .toFixed(2)
    .replace(/\.00$/u, "")
    .replace(/(\.\d)0$/u, "$1");
}

export function parseMemberBenefitCatalog(raw: unknown): MemberBenefitCatalogView | null {
  const parsed = MemberBenefitCatalogResultSchema.safeParse(unwrapQueryResult(raw));
  return parsed.success ? parsed.data : null;
}

export function parseMemberBenefits(raw: unknown): MemberBenefitsView | null {
  const parsed = MemberBenefitsResultSchema.safeParse(unwrapQueryResult(raw));
  return parsed.success ? parsed.data : null;
}

export function parseMemberBenefitMutation(raw: unknown): MemberBenefitMutationView | null {
  const parsed = MemberBenefitMutationResultSchema.safeParse(unwrapQueryResult(raw));
  return parsed.success ? parsed.data : null;
}

export function listBenefitDefinitions(
  catalog: MemberBenefitCatalogView,
): readonly BenefitCatalogDefinition[] {
  return Object.freeze([
    ...catalog.tiers.map((item) => Object.freeze({ ...item, kind: "tier" as const })),
    ...(catalog.points_policy === null
      ? []
      : [Object.freeze({ ...catalog.points_policy, kind: "points_policy" as const })]),
    ...catalog.punch_types.map((item) => Object.freeze({ ...item, kind: "punch_type" as const })),
    ...catalog.coupon_types.map((item) => Object.freeze({ ...item, kind: "coupon_type" as const })),
  ]);
}

export function benefitDefinitionDraft(item: BenefitCatalogDefinition): BenefitDefinitionDraft {
  if (item.kind === "points_policy") {
    return Object.freeze({
      kind: item.kind,
      definitionId: item.policy_id,
      expectedVersion: item.version,
      code: "",
      name: "积分规则",
      primary: centsToYuanInput(item.unit_cents),
      secondary: String(item.points_per_unit),
      validDays: String(item.valid_days),
      note: item.note ?? "",
    });
  }
  return Object.freeze({
    kind: item.kind,
    definitionId: item.definition_id,
    expectedVersion: item.version,
    code: item.code,
    name: item.name,
    primary:
      item.kind === "tier"
        ? String(item.level)
        : item.kind === "punch_type"
          ? String(item.total_uses)
          : centsToYuanInput(item.discount_cents),
    secondary:
      item.kind === "tier"
        ? formatBenefitDiscountPercent(item.discount_bps)
        : item.kind === "coupon_type"
          ? centsToYuanInput(item.min_order_cents)
          : "",
    validDays: item.kind === "tier" ? "" : String(item.valid_days),
    note: item.note ?? "",
  });
}

export function buildBenefitDefinitionBody(
  draft: BenefitDefinitionDraft,
  status: "active" | "retired" = "active",
): Readonly<{ definition: MemberBenefitDefinitionInput }> | null {
  const note = draft.note.trim();
  const common = {
    expected_version: draft.expectedVersion,
    status,
    ...(note.length === 0 ? {} : { note }),
  } as const;
  let definition: unknown;
  if (draft.kind === "points_policy") {
    const unitCents = yuanAmountToCents(draft.primary);
    const pointsPerUnit = positiveInteger(draft.secondary, 100_000);
    const validDays = positiveInteger(draft.validDays, 3_650);
    if (unitCents === null || pointsPerUnit === null || validDays === null) return null;
    definition = {
      kind: draft.kind,
      ...common,
      unit_cents: unitCents,
      points_per_unit: pointsPerUnit,
      valid_days: validDays,
    };
  } else {
    const identity = {
      ...(draft.definitionId === null ? {} : { definition_id: draft.definitionId }),
      code: draft.code.trim(),
      name: draft.name.trim(),
    } as const;
    if (draft.kind === "tier") {
      const level = positiveInteger(draft.primary, 99);
      const discountBps = basisPointPercent(draft.secondary);
      if (level === null || discountBps === null) return null;
      definition = {
        kind: draft.kind,
        ...common,
        ...identity,
        level,
        discount_bps: discountBps,
      };
    } else if (draft.kind === "punch_type") {
      const totalUses = positiveInteger(draft.primary, 999);
      const validDays = positiveInteger(draft.validDays, 3_650);
      if (totalUses === null || validDays === null) return null;
      definition = {
        kind: draft.kind,
        ...common,
        ...identity,
        total_uses: totalUses,
        valid_days: validDays,
      };
    } else {
      const discountCents = yuanAmountToCents(draft.primary);
      const minOrderCents = nonNegativeYuan(draft.secondary);
      const validDays = positiveInteger(draft.validDays, 3_650);
      if (discountCents === null || minOrderCents === null || validDays === null) return null;
      definition = {
        kind: draft.kind,
        ...common,
        ...identity,
        discount_cents: discountCents,
        min_order_cents: minOrderCents,
        valid_days: validDays,
      };
    }
  }
  const result = MemberBenefitDefinitionUpsertInputSchema.safeParse({ definition });
  return result.success ? Object.freeze(result.data) : null;
}

export function buildMembershipSetBody(
  benefits: MemberBenefitsView,
  tierId: string | null,
  validUntil: string | null,
  reason: string,
) {
  const parsed = MemberMembershipSetInputSchema.safeParse({
    account_id: benefits.account_id,
    expected_version: benefits.membership.version,
    tier_id: tierId,
    valid_until: validUntil,
    reason: reason.trim(),
  });
  return parsed.success ? Object.freeze(parsed.data) : null;
}

export function buildPointsEarnBody(accountId: string, orderId: string) {
  return Object.freeze({ account_id: accountId, order_id: orderId });
}

export function buildPointsRedeemBody(accountId: string, points: number, reason: string) {
  const parsed = MemberPointsRedeemInputSchema.safeParse({
    account_id: accountId,
    points,
    reason: reason.trim(),
  });
  return parsed.success ? Object.freeze(parsed.data) : null;
}

export function buildAssetGrantBody(
  assetKind: "punch" | "coupon",
  accountId: string,
  definitionId: string,
  reason: string,
) {
  const parsed = MemberAssetGrantInputSchema.safeParse({
    asset_kind: assetKind,
    account_id: accountId,
    definition_id: definitionId,
    reason: reason.trim(),
  });
  return parsed.success ? Object.freeze(parsed.data) : null;
}

export function buildPunchConsumeBody(assetId: string, uses: number, reason: string) {
  const parsed = MemberAssetConsumeInputSchema.safeParse({
    asset: Object.freeze({ asset_kind: "punch" as const, asset_id: assetId, uses }),
    reason: reason.trim(),
  });
  return parsed.success ? Object.freeze(parsed.data) : null;
}

export function buildCouponConsumeBody(assetId: string, orderId: string) {
  const parsed = MemberAssetConsumeInputSchema.safeParse({
    asset: Object.freeze({ asset_kind: "coupon" as const, asset_id: assetId, order_id: orderId }),
  });
  return parsed.success ? Object.freeze(parsed.data) : null;
}

export function isCouponEligible(
  coupon: MemberBenefitsView["coupons"][number],
  order: Readonly<{
    status: string;
    paid_cents: number;
    discount_cents: number;
    original_cents: number;
  }>,
): boolean {
  return (
    coupon.status === "active" &&
    order.status === "open" &&
    order.paid_cents === 0 &&
    order.discount_cents === 0 &&
    order.original_cents >= coupon.min_order_cents
  );
}
