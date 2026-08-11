import { PricingAddonSchema, PricingPolicySchema, type PricingAddon } from "@laundry/contracts";

export type StorePricingPolicy = Readonly<{
  version: number;
  urgent_cents: number;
  freight_cents: number;
  addons: readonly PricingAddon[];
  updated_at: number | null;
}>;

export type PricingPolicySetRequest = Readonly<{
  org_id: string;
  store_id: string;
  staff_id: string;
  expected_version: number;
  urgent_cents: number;
  freight_cents: number;
  addons: readonly PricingAddon[];
  updated_at: number;
}>;

export type PricingPolicyChange = Readonly<{
  before: StorePricingPolicy;
  after: StorePricingPolicy;
}>;

export type PricingPolicyStore = Readonly<{
  get: (orgId: string, storeId: string) => Promise<StorePricingPolicy>;
  /** Null means the optimistic expected_version no longer matches. */
  set: (request: PricingPolicySetRequest) => Promise<PricingPolicyChange | null>;
}>;

export const EMPTY_PRICING_POLICY: StorePricingPolicy = Object.freeze({
  version: 0,
  urgent_cents: 0,
  freight_cents: 0,
  addons: Object.freeze([]),
  updated_at: null,
});

/** Validate persisted JSON again and return a deterministic immutable catalog. */
export function normalizePricingAddons(value: unknown): readonly PricingAddon[] {
  const parsed = PricingAddonSchema.array().max(50).safeParse(value);
  if (!parsed.success) throw new TypeError("Invalid persisted pricing add-on catalog");
  const codes = new Set<string>();
  for (const addon of parsed.data) {
    if (codes.has(addon.code)) throw new TypeError("Duplicate pricing add-on code");
    codes.add(addon.code);
  }
  return Object.freeze(
    parsed.data
      .map((addon) => Object.freeze({ ...addon }))
      .sort(
        (left, right) => left.sort_order - right.sort_order || left.code.localeCompare(right.code),
      ),
  );
}

export function freezePricingPolicy(input: StorePricingPolicy): StorePricingPolicy {
  const parsed = PricingPolicySchema.safeParse(input);
  if (!parsed.success) throw new TypeError("Invalid persisted pricing policy");
  return Object.freeze({
    ...parsed.data,
    addons: normalizePricingAddons(parsed.data.addons),
  });
}
