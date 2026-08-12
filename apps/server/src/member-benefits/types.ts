import type {
  MemberBenefitCatalogResult,
  MemberBenefitDefinitionUpsertInput,
  MemberBenefitsResult,
} from "@laundry/contracts";

type DeepReadonly<TValue> = TValue extends readonly (infer TItem)[]
  ? readonly DeepReadonly<TItem>[]
  : TValue extends object
    ? { readonly [TKey in keyof TValue]: DeepReadonly<TValue[TKey]> }
    : TValue;

export type MemberBenefitCatalogView = DeepReadonly<MemberBenefitCatalogResult>;
export type MemberBenefitsView = DeepReadonly<MemberBenefitsResult>;

export type BenefitDefinitionInput = MemberBenefitDefinitionUpsertInput["definition"];

export type BenefitDefinitionRecord =
  | Readonly<{
      kind: "tier";
      definition_id: string;
      code: string;
      name: string;
      level: number;
      discount_bps: number;
      status: "active" | "retired";
      version: number;
      note: string | null;
    }>
  | Readonly<{
      kind: "points_policy";
      policy_id: string;
      unit_cents: number;
      points_per_unit: number;
      valid_days: number;
      status: "active" | "retired";
      version: number;
      note: string | null;
    }>
  | Readonly<{
      kind: "punch_type";
      definition_id: string;
      code: string;
      name: string;
      total_uses: number;
      valid_days: number;
      status: "active" | "retired";
      version: number;
      note: string | null;
    }>
  | Readonly<{
      kind: "coupon_type";
      definition_id: string;
      code: string;
      name: string;
      discount_cents: number;
      min_order_cents: number;
      valid_days: number;
      status: "active" | "retired";
      version: number;
      note: string | null;
    }>;

export type MembershipRecord = Readonly<{
  account_id: string;
  version: number;
  tier: Readonly<{
    definition_id: string;
    code: string;
    name: string;
    level: number;
    definition_version: number;
    discount_bps: number;
  }> | null;
  valid_until: string | null;
}>;

export type OrderMembershipPolicySnapshot = Readonly<{
  version: number;
  tier: MembershipRecord["tier"];
}>;

export type PointsLedgerRecord = Readonly<{
  ledger_id: string;
  account_id: string;
  kind: "earn" | "redeem";
  points_delta: number;
  order_id: string | null;
  expires_on: string | null;
  at: number;
  note: string | null;
}>;

export type PointsAllocationRecord = Readonly<{
  allocation_id: string;
  redeem_ledger_id: string;
  earn_ledger_id: string;
  points: number;
}>;

export type PunchCardRecord = Readonly<{
  asset_id: string;
  account_id: string;
  definition_id: string;
  code: string;
  name: string;
  total_uses: number;
  issued_on: string;
  expires_on: string;
}>;

export type PunchConsumeRecord = Readonly<{
  ledger_id: string;
  asset_id: string;
  uses: number;
  at: number;
  reason: string;
}>;

export type CouponGrantRecord = Readonly<{
  asset_id: string;
  account_id: string;
  definition_id: string;
  code: string;
  name: string;
  discount_cents: number;
  min_order_cents: number;
  granted_on: string;
  expires_on: string;
}>;

export type CouponRedemptionRecord = Readonly<{
  redemption_id: string;
  asset_id: string;
  account_id: string;
  store_id: string;
  order_id: string;
  discount_cents: number;
  at: number;
}>;

export type CouponRedemptionReversalRecord = Readonly<{
  reversal_id: string;
  redemption_id: string;
  asset_id: string;
  order_id: string;
  staff_id: string;
  at: number;
  reason: string;
}>;

export type MemberBenefitRejectReason =
  | "account_not_found"
  | "account_frozen"
  | "account_closed"
  | "definition_not_found"
  | "definition_retired"
  | "definition_version_conflict"
  | "definition_code_conflict"
  | "membership_version_conflict"
  | "past_expiry"
  | "points_policy_missing"
  | "order_not_found"
  | "order_customer_mismatch"
  | "order_not_settled"
  | "points_zero"
  | "insufficient_points"
  | "asset_not_found"
  | "asset_expired"
  | "insufficient_uses"
  | "coupon_already_redeemed"
  | "coupon_order_invalid"
  | "coupon_order_already_discounted";

export type MemberBenefitOutcome<TValue> =
  | Readonly<{ ok: true; value: TValue }>
  | Readonly<{ ok: false; reason: MemberBenefitRejectReason }>;

export type BenefitMutationResult = Readonly<{
  benefits: MemberBenefitsView;
  entity_id: string;
  changed: boolean;
}>;

export type DefinitionMutationResult = Readonly<{
  catalog: MemberBenefitCatalogView;
  definition: BenefitDefinitionRecord;
}>;

type MutationEvidence = Readonly<{
  store_id: string;
  staff_id: string;
  at: number;
  business_date: string;
}>;

export type DefinitionUpsertStoreInput = Readonly<{
  definition: BenefitDefinitionInput;
  staff_id: string;
  at: number;
}>;

export type MembershipSetStoreInput = MutationEvidence &
  Readonly<{
    account_id: string;
    expected_version: number;
    tier_id: string | null;
    valid_until: string | null;
    reason: string;
  }>;

export type PointsEarnStoreInput = MutationEvidence &
  Readonly<{
    account_id: string;
    order_id: string;
  }>;

export type PointsRedeemStoreInput = MutationEvidence &
  Readonly<{
    account_id: string;
    points: number;
    reason: string;
  }>;

export type AssetGrantStoreInput = MutationEvidence &
  Readonly<{
    asset_kind: "punch" | "coupon";
    account_id: string;
    definition_id: string;
    reason: string;
  }>;

export type PunchConsumeStoreInput = MutationEvidence &
  Readonly<{
    asset_id: string;
    uses: number;
    reason: string;
  }>;

export type CouponConsumeStoreInput = MutationEvidence &
  Readonly<{
    asset_id: string;
    order_id: string;
  }>;

export type CouponCancellationStoreInput = Readonly<{
  order_id: string;
  store_id: string;
  staff_id: string;
  at: number;
  reason: string;
}>;

export type CouponCancellationResult = Readonly<{
  changed: boolean;
  asset_id: string | null;
  reversal_id: string | null;
}>;

export type BenefitsGetStoreInput = Readonly<{
  customer_id: string;
  include_expired: boolean;
  business_date: string;
}>;

export type MemberBenefitsStore = Readonly<{
  upsertDefinition: (
    input: DefinitionUpsertStoreInput,
  ) => Promise<MemberBenefitOutcome<DefinitionMutationResult>>;
  setMembership: (
    input: MembershipSetStoreInput,
  ) => Promise<MemberBenefitOutcome<BenefitMutationResult>>;
  earnPoints: (input: PointsEarnStoreInput) => Promise<MemberBenefitOutcome<BenefitMutationResult>>;
  redeemPoints: (
    input: PointsRedeemStoreInput,
  ) => Promise<MemberBenefitOutcome<BenefitMutationResult>>;
  grantAsset: (input: AssetGrantStoreInput) => Promise<MemberBenefitOutcome<BenefitMutationResult>>;
  consumePunch: (
    input: PunchConsumeStoreInput,
  ) => Promise<MemberBenefitOutcome<BenefitMutationResult>>;
  consumeCoupon: (
    input: CouponConsumeStoreInput,
  ) => Promise<MemberBenefitOutcome<BenefitMutationResult>>;
  reverseCouponForOrder: (input: CouponCancellationStoreInput) => Promise<CouponCancellationResult>;
  getCatalog: (includeRetired: boolean) => Promise<MemberBenefitCatalogView>;
  getBenefits: (input: BenefitsGetStoreInput) => Promise<MemberBenefitOutcome<MemberBenefitsView>>;
  resolveOrderMembership: (
    customerId: string,
    businessDate: string,
  ) => Promise<OrderMembershipPolicySnapshot | null>;
}>;

export type MemberBenefitsRuntimeDeps = Readonly<{
  persistence?: "memory" | "sql";
  store: MemberBenefitsStore;
}>;
