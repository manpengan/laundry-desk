import type { MemberCouponGrantViewSchema, MemberPunchCardViewSchema } from "@laundry/contracts";
import type { z } from "zod";

import type { MemberAccountRecord } from "../member/types.js";
import { isExpiredOn } from "./date.js";
import { activeCouponRedemption } from "./memory-coupons.js";
import type { MemoryBenefitsState } from "./memory-state.js";
import type {
  BenefitDefinitionRecord,
  MemberBenefitCatalogView,
  MemberBenefitsView,
  PointsLedgerRecord,
} from "./types.js";

type PunchView = z.output<typeof MemberPunchCardViewSchema>;
type CouponView = z.output<typeof MemberCouponGrantViewSchema>;

const byCode = <TValue extends Readonly<{ code: string }>>(left: TValue, right: TValue): number =>
  left.code.localeCompare(right.code);

const tierView = (
  tier: Extract<BenefitDefinitionRecord, { kind: "tier" }>,
): MemberBenefitCatalogView["tiers"][number] =>
  Object.freeze({
    definition_id: tier.definition_id,
    code: tier.code,
    name: tier.name,
    level: tier.level,
    discount_bps: tier.discount_bps,
    status: tier.status,
    version: tier.version,
    note: tier.note,
  });

const punchTypeView = (
  definition: Extract<BenefitDefinitionRecord, { kind: "punch_type" }>,
): MemberBenefitCatalogView["punch_types"][number] =>
  Object.freeze({
    definition_id: definition.definition_id,
    code: definition.code,
    name: definition.name,
    total_uses: definition.total_uses,
    valid_days: definition.valid_days,
    status: definition.status,
    version: definition.version,
    note: definition.note,
  });

const couponTypeView = (
  definition: Extract<BenefitDefinitionRecord, { kind: "coupon_type" }>,
): MemberBenefitCatalogView["coupon_types"][number] =>
  Object.freeze({
    definition_id: definition.definition_id,
    code: definition.code,
    name: definition.name,
    discount_cents: definition.discount_cents,
    min_order_cents: definition.min_order_cents,
    valid_days: definition.valid_days,
    status: definition.status,
    version: definition.version,
    note: definition.note,
  });

const pointsLedgerView = (
  row: PointsLedgerRecord,
): MemberBenefitsView["points"]["recent"][number] =>
  Object.freeze({
    ledger_id: row.ledger_id,
    kind: row.kind,
    points_delta: row.points_delta,
    order_id: row.order_id,
    expires_on: row.expires_on,
    at: row.at,
    note: row.note,
  });

export function catalogFromState(
  state: MemoryBenefitsState,
  includeRetired: boolean,
): MemberBenefitCatalogView {
  const visible = <TValue extends Readonly<{ status: "active" | "retired" }>>(
    values: Iterable<TValue>,
  ): readonly TValue[] =>
    [...values].filter((value) => includeRetired || value.status === "active");

  return Object.freeze({
    tiers: Object.freeze(visible(state.tiers.values()).map(tierView).sort(byCode)),
    points_policy:
      state.pointsPolicy === null || (!includeRetired && state.pointsPolicy.status === "retired")
        ? null
        : Object.freeze({
            policy_id: state.pointsPolicy.policy_id,
            unit_cents: state.pointsPolicy.unit_cents,
            points_per_unit: state.pointsPolicy.points_per_unit,
            valid_days: state.pointsPolicy.valid_days,
            status: state.pointsPolicy.status,
            version: state.pointsPolicy.version,
            note: state.pointsPolicy.note,
          }),
    punch_types: Object.freeze(visible(state.punchTypes.values()).map(punchTypeView).sort(byCode)),
    coupon_types: Object.freeze(
      visible(state.couponTypes.values()).map(couponTypeView).sort(byCode),
    ),
  });
}

const allocatedByEarn = (state: MemoryBenefitsState): ReadonlyMap<string, number> => {
  const totals = new Map<string, number>();
  for (const allocation of state.pointsAllocations) {
    totals.set(
      allocation.earn_ledger_id,
      (totals.get(allocation.earn_ledger_id) ?? 0) + allocation.points,
    );
  }
  return totals;
};

export function availablePointCredits(
  state: MemoryBenefitsState,
  accountId: string,
  businessDate: string,
): readonly Readonly<{ ledger_id: string; remaining: number; expires_on: string; at: number }>[] {
  const allocated = allocatedByEarn(state);
  return Object.freeze(
    state.pointsLedger
      .filter(
        (row) =>
          row.account_id === accountId &&
          row.kind === "earn" &&
          row.expires_on !== null &&
          !isExpiredOn(row.expires_on, businessDate),
      )
      .map((row) =>
        Object.freeze({
          ledger_id: row.ledger_id,
          remaining: row.points_delta - (allocated.get(row.ledger_id) ?? 0),
          expires_on: row.expires_on!,
          at: row.at,
        }),
      )
      .filter((row) => row.remaining > 0)
      .sort(
        (left, right) =>
          left.expires_on.localeCompare(right.expires_on) ||
          left.at - right.at ||
          left.ledger_id.localeCompare(right.ledger_id),
      ),
  );
}

function punchViews(
  state: MemoryBenefitsState,
  accountId: string,
  businessDate: string,
): readonly PunchView[] {
  return [...state.punchCards.values()]
    .filter((card) => card.account_id === accountId)
    .map((card): PunchView => {
      const used = state.punchConsumes
        .filter((row) => row.asset_id === card.asset_id)
        .reduce((sum, row) => sum + row.uses, 0);
      const remaining = card.total_uses - used;
      const status =
        remaining === 0
          ? "exhausted"
          : isExpiredOn(card.expires_on, businessDate)
            ? "expired"
            : "active";
      return Object.freeze({
        asset_id: card.asset_id,
        definition_id: card.definition_id,
        code: card.code,
        name: card.name,
        total_uses: card.total_uses,
        used_uses: used,
        remaining_uses: remaining,
        issued_on: card.issued_on,
        expires_on: card.expires_on,
        status,
      });
    })
    .sort((left, right) => left.expires_on.localeCompare(right.expires_on));
}

function couponViews(
  state: MemoryBenefitsState,
  accountId: string,
  businessDate: string,
): readonly CouponView[] {
  return [...state.couponGrants.values()]
    .filter((grant) => grant.account_id === accountId)
    .map((grant): CouponView => {
      const redemption = activeCouponRedemption(state, grant.asset_id);
      const status =
        redemption !== undefined
          ? "redeemed"
          : isExpiredOn(grant.expires_on, businessDate)
            ? "expired"
            : "active";
      return Object.freeze({
        asset_id: grant.asset_id,
        definition_id: grant.definition_id,
        code: grant.code,
        name: grant.name,
        discount_cents: grant.discount_cents,
        min_order_cents: grant.min_order_cents,
        granted_on: grant.granted_on,
        expires_on: grant.expires_on,
        status,
        redeemed_order_id: redemption?.order_id ?? null,
      });
    })
    .sort((left, right) => left.expires_on.localeCompare(right.expires_on));
}

export function benefitsFromState(
  state: MemoryBenefitsState,
  account: MemberAccountRecord,
  businessDate: string,
  includeExpired: boolean,
): MemberBenefitsView {
  const membership = state.memberships.get(account.account_id);
  const credits = availablePointCredits(state, account.account_id, businessDate);
  const lifetime = state.pointsLedger
    .filter((row) => row.account_id === account.account_id && row.kind === "earn")
    .reduce((sum, row) => sum + row.points_delta, 0);
  const recent = state.pointsLedger
    .filter((row) => row.account_id === account.account_id)
    .sort((left, right) => right.at - left.at || right.ledger_id.localeCompare(left.ledger_id))
    .slice(0, 50)
    .map(pointsLedgerView);
  const punches = punchViews(state, account.account_id, businessDate);
  const coupons = couponViews(state, account.account_id, businessDate);

  return Object.freeze({
    account_id: account.account_id,
    customer_id: account.customer_id,
    account_status: account.status,
    membership: Object.freeze({
      version: membership?.version ?? 0,
      tier:
        membership?.tier === undefined || membership.tier === null
          ? null
          : Object.freeze({
              definition_id: membership.tier.definition_id,
              code: membership.tier.code,
              name: membership.tier.name,
              level: membership.tier.level,
              discount_bps: membership.tier.discount_bps,
            }),
      valid_until: membership?.valid_until ?? null,
      status:
        membership?.tier === null || membership === undefined
          ? "unassigned"
          : isExpiredOn(membership.valid_until!, businessDate)
            ? "expired"
            : "active",
    }),
    points: Object.freeze({
      available_points: credits.reduce((sum, credit) => sum + credit.remaining, 0),
      lifetime_earned_points: lifetime,
      recent: Object.freeze(recent),
    }),
    punch_cards: Object.freeze(
      includeExpired ? punches : punches.filter((row) => row.status === "active"),
    ),
    coupons: Object.freeze(
      includeExpired ? coupons : coupons.filter((row) => row.status === "active"),
    ),
  });
}
