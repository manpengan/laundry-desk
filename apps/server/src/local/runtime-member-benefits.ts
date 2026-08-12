import type { OrderStore } from "../order/types.js";
import { createMemoryMemberDeps, createPgMemberDeps } from "../member/runtime.js";
import {
  createMemoryMemberBenefitsDeps,
  createPgMemberBenefitsDeps,
} from "../member-benefits/runtime.js";
import { LOCAL_PROFILE } from "./profile.js";

export function createMemoryMemberRuntimes(
  customers: readonly Readonly<{ customer_id: string }>[],
  orderStore: OrderStore,
) {
  const member = createMemoryMemberDeps(customers.map((row) => row.customer_id));
  return Object.freeze({
    member,
    memberBenefits: createMemoryMemberBenefitsDeps({
      orgId: LOCAL_PROFILE.orgId,
      memberStore: member.store,
      orderStore,
    }),
    customerMerge: member.customerMerge,
  });
}

export function createPgMemberRuntimes(orderStore: OrderStore) {
  const member = createPgMemberDeps();
  return Object.freeze({
    member,
    memberBenefits: createPgMemberBenefitsDeps({
      orgId: LOCAL_PROFILE.orgId,
      memberStore: member.store,
      orderStore,
    }),
  });
}
