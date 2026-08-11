import {
  EMPTY_PRICING_POLICY,
  freezePricingPolicy,
  type PricingPolicyStore,
  type StorePricingPolicy,
} from "./types.js";

const policyKey = (orgId: string, storeId: string): string => `${orgId}|${storeId}`;

export function createMemoryPricingPolicyStore(): PricingPolicyStore {
  const policies = new Map<string, StorePricingPolicy>();
  return Object.freeze({
    async get(orgId, storeId) {
      return policies.get(policyKey(orgId, storeId)) ?? EMPTY_PRICING_POLICY;
    },
    async set(request) {
      const key = policyKey(request.org_id, request.store_id);
      const before = policies.get(key) ?? EMPTY_PRICING_POLICY;
      if (before.version !== request.expected_version) return null;
      const after = freezePricingPolicy({
        version: before.version + 1,
        urgent_cents: request.urgent_cents,
        freight_cents: request.freight_cents,
        addons: request.addons,
        updated_at: request.updated_at,
      });
      policies.set(key, after);
      return Object.freeze({ before, after });
    },
  });
}
