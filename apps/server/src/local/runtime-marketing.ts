import type { CustomerRecord } from "../customer/types.js";
import { createMemoryMarketingStore } from "../marketing/memory-store.js";
import { createPgMarketingStore } from "../marketing/pg-store.js";
import type { MarketingHandlerDeps, MemoryAudienceCustomer } from "../marketing/types.js";
import type { FeaturesStore } from "../platform/features.js";

function audienceCustomer(customer: CustomerRecord): MemoryAudienceCustomer {
  return Object.freeze({
    customerId: customer.customer_id,
    createdAt: new Date(customer.created_at * 1_000),
    lastOrderAt: null,
    activeMember: false,
    tierId: null,
    tierValidUntil: null,
  });
}

export function createMemoryMarketingRuntime(
  features: FeaturesStore,
  customers: readonly CustomerRecord[],
): MarketingHandlerDeps {
  return Object.freeze({
    store: createMemoryMarketingStore({ customers: customers.map(audienceCustomer) }),
    features,
  });
}

export function createPgMarketingRuntime(features: FeaturesStore): MarketingHandlerDeps {
  return Object.freeze({ store: createPgMarketingStore(), features, persistence: "sql" });
}
