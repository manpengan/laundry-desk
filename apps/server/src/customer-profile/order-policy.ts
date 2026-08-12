import type { SqlClient, TenantContext } from "../db/types.js";
import { createPgMemberBenefitsStore } from "../member-benefits/pg-store.js";
import type {
  MemberBenefitsRuntimeDeps,
  OrderMembershipPolicySnapshot,
} from "../member-benefits/types.js";
import type { CustomerProfileStore } from "./types.js";

export type OrderTierSnapshot = Readonly<{
  tier_id: string;
  definition_version: number;
  code: string;
  name: string;
  level: number;
  discount_bps: number;
}>;

export type CustomerOrderPolicySnapshot = Readonly<{
  customer_profile_version: number;
  customer_discount_bps: number | null;
  membership_version: number | null;
  tier: OrderTierSnapshot | null;
  waivers: Readonly<{
    skip_ticket_print: boolean;
    skip_label_print: boolean;
    skip_rack_assignment: boolean;
  }>;
}>;

export type CustomerOrderPolicyResolver = (
  client: SqlClient,
  tenant: TenantContext,
  customerId: string,
  businessDate: string,
) => Promise<CustomerOrderPolicySnapshot>;

const NO_WAIVERS = Object.freeze({
  skip_ticket_print: false,
  skip_label_print: false,
  skip_rack_assignment: false,
});

function tierSnapshot(membership: OrderMembershipPolicySnapshot | null): OrderTierSnapshot | null {
  const tier = membership?.tier;
  return tier === null || tier === undefined
    ? null
    : Object.freeze({
        tier_id: tier.definition_id,
        definition_version: tier.definition_version,
        code: tier.code,
        name: tier.name,
        level: tier.level,
        discount_bps: tier.discount_bps,
      });
}

export function createCustomerOrderPolicyResolver(
  profiles: CustomerProfileStore,
  memberBenefits: MemberBenefitsRuntimeDeps,
): CustomerOrderPolicyResolver {
  return async (client, tenant, customerId, businessDate) => {
    const profile = await (profiles.getForOrder ?? profiles.get)(customerId);
    const membership = await (memberBenefits.persistence === "sql"
      ? createPgMemberBenefitsStore(client, tenant).resolveOrderMembership(customerId, businessDate)
      : memberBenefits.store.resolveOrderMembership(customerId, businessDate));
    return Object.freeze({
      customer_profile_version: profile?.version ?? 0,
      customer_discount_bps: profile?.discount_bps ?? null,
      membership_version: membership?.version ?? null,
      tier: tierSnapshot(membership),
      waivers: profile?.waivers ?? NO_WAIVERS,
    });
  };
}
