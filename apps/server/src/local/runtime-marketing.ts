import type { CustomerRecord } from "../customer/types.js";
import type { MemberBenefitsStore } from "../member-benefits/types.js";
import type { MemberStore } from "../member/types.js";
import type { OrderStore } from "../order/types.js";
import { createMemoryMarketingStore } from "../marketing/memory-store.js";
import { createPgMarketingStore } from "../marketing/pg-store.js";
import type { MarketingHandlerDeps, MemoryAudienceCustomer } from "../marketing/types.js";
import type { FeaturesStore } from "../platform/features.js";

type MarketingMemberRuntimes = Readonly<{
  member: Readonly<{ store: MemberStore }>;
  memberBenefits: Readonly<{ store: MemberBenefitsStore }>;
}>;

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
  members: MarketingMemberRuntimes,
  orderStore: OrderStore,
): MarketingHandlerDeps {
  return Object.freeze({
    store: createMemoryMarketingStore({
      customers: customers.map(audienceCustomer),
      memberStore: members.member.store,
      memberBenefits: members.memberBenefits.store,
      orderStore,
    }),
    features,
  });
}

export function createPgMarketingRuntime(features: FeaturesStore): MarketingHandlerDeps {
  return Object.freeze({ store: createPgMarketingStore(), features, persistence: "sql" });
}
