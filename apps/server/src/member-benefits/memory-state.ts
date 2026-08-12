import type { MemberStore } from "../member/types.js";
import type { OrderStore } from "../order/types.js";
import type {
  BenefitDefinitionRecord,
  CouponGrantRecord,
  CouponRedemptionRecord,
  CouponRedemptionReversalRecord,
  MembershipRecord,
  PointsAllocationRecord,
  PointsLedgerRecord,
  PunchCardRecord,
  PunchConsumeRecord,
} from "./types.js";

export type MemoryBenefitsState = Readonly<{
  tiers: ReadonlyMap<string, Extract<BenefitDefinitionRecord, { kind: "tier" }>>;
  pointsPolicy: Extract<BenefitDefinitionRecord, { kind: "points_policy" }> | null;
  punchTypes: ReadonlyMap<string, Extract<BenefitDefinitionRecord, { kind: "punch_type" }>>;
  couponTypes: ReadonlyMap<string, Extract<BenefitDefinitionRecord, { kind: "coupon_type" }>>;
  memberships: ReadonlyMap<string, MembershipRecord>;
  pointsLedger: readonly PointsLedgerRecord[];
  pointsAllocations: readonly PointsAllocationRecord[];
  punchCards: ReadonlyMap<string, PunchCardRecord>;
  punchConsumes: readonly PunchConsumeRecord[];
  couponGrants: ReadonlyMap<string, CouponGrantRecord>;
  couponRedemptions: readonly CouponRedemptionRecord[];
  couponRedemptionReversals: readonly CouponRedemptionReversalRecord[];
}>;

export type MemoryBenefitsContext = Readonly<{
  orgId: string;
  memberStore: MemberStore;
  orderStore: OrderStore;
  newId: () => string;
  read: () => MemoryBenefitsState;
  write: (state: MemoryBenefitsState) => void;
}>;

export const EMPTY_MEMORY_BENEFITS_STATE: MemoryBenefitsState = Object.freeze({
  tiers: new Map(),
  pointsPolicy: null,
  punchTypes: new Map(),
  couponTypes: new Map(),
  memberships: new Map(),
  pointsLedger: Object.freeze([]),
  pointsAllocations: Object.freeze([]),
  punchCards: new Map(),
  punchConsumes: Object.freeze([]),
  couponGrants: new Map(),
  couponRedemptions: Object.freeze([]),
  couponRedemptionReversals: Object.freeze([]),
});

export function mapWith<TKey, TValue>(
  source: ReadonlyMap<TKey, TValue>,
  key: TKey,
  value: TValue,
): ReadonlyMap<TKey, TValue> {
  const next = new Map(source);
  next.set(key, value);
  return next;
}

export const appendRecord = <TValue>(source: readonly TValue[], value: TValue): readonly TValue[] =>
  Object.freeze([...source, value]);
