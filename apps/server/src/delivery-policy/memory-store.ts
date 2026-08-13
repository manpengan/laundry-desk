import {
  EMPTY_DELIVERY_POLICY,
  policyFromSetRequest,
  type DeliveryPolicyStore,
  type StoreDeliveryPolicy,
} from "./types.js";

const policyKey = (orgId: string, storeId: string): string => `${orgId}|${storeId}`;

export function createMemoryDeliveryPolicyStore(): DeliveryPolicyStore {
  const policies = new Map<string, StoreDeliveryPolicy>();
  return Object.freeze({
    async get(orgId, storeId) {
      return policies.get(policyKey(orgId, storeId)) ?? EMPTY_DELIVERY_POLICY;
    },
    async set(request) {
      const key = policyKey(request.org_id, request.store_id);
      const before = policies.get(key) ?? EMPTY_DELIVERY_POLICY;
      if (before.version !== request.expected_version) return null;
      const after = policyFromSetRequest(request, before.version + 1);
      policies.set(key, after);
      return Object.freeze({ before, after });
    },
  });
}
