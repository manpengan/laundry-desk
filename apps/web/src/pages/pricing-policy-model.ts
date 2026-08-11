import { PricingPolicySchema, type PricingPolicy } from "@laundry/contracts";

export type PricingPolicyView = Readonly<{
  version: number;
  urgent_cents: number;
  freight_cents: number;
  addons: readonly Readonly<PricingPolicy["addons"][number]>[];
  updated_at: number | null;
}>;

export const EMPTY_PRICING_POLICY: PricingPolicyView = Object.freeze({
  version: 0,
  urgent_cents: 0,
  freight_cents: 0,
  addons: Object.freeze([]),
  updated_at: null,
});

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function unwrapBusResult(value: unknown): unknown {
  if (!isRecord(value)) return null;
  return "result" in value ? value.result : value;
}

export function freezePricingPolicy(policy: PricingPolicy): PricingPolicyView {
  return Object.freeze({
    ...policy,
    addons: Object.freeze(policy.addons.map((addon) => Object.freeze({ ...addon }))),
  });
}

export function readPricingPolicy(value: unknown): PricingPolicyView | null {
  const result = unwrapBusResult(value);
  if (!isRecord(result)) return null;
  const parsed = PricingPolicySchema.safeParse(result.policy);
  return parsed.success ? freezePricingPolicy(parsed.data) : null;
}

export function activePricingAddons(policy: PricingPolicyView) {
  return Object.freeze(policy.addons.filter((addon) => addon.is_active));
}
