import type { OrderHandlerDeps } from "../order/deps.js";
import { createPgMemberBenefitsStore } from "./pg-store.js";
import type { MemberBenefitsRuntimeDeps } from "./types.js";

export function withMemberBenefitCouponCancellation(
  order: OrderHandlerDeps,
  memberBenefits: MemberBenefitsRuntimeDeps | undefined,
): OrderHandlerDeps {
  if (memberBenefits === undefined || order.couponCancellation !== undefined) return order;
  return Object.freeze({
    ...order,
    couponCancellation: async (client, tenant, input) => {
      const store =
        memberBenefits.persistence === "sql"
          ? createPgMemberBenefitsStore(client, tenant)
          : memberBenefits.store;
      await store.reverseCouponForOrder(input);
    },
  });
}
