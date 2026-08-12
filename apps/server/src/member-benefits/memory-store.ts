import { randomUUID } from "node:crypto";

import type { MemberStore } from "../member/types.js";
import type { OrderStore } from "../order/types.js";
import { consumeMemoryCoupon, consumeMemoryPunch, grantMemoryAsset } from "./memory-assets.js";
import { reverseMemoryCouponForOrder } from "./memory-coupons.js";
import { setMemoryMembership, upsertMemoryDefinition } from "./memory-definitions.js";
import { earnMemoryPoints, redeemMemoryPoints } from "./memory-points.js";
import {
  EMPTY_MEMORY_BENEFITS_STATE,
  type MemoryBenefitsContext,
  type MemoryBenefitsState,
} from "./memory-state.js";
import { rejectBenefit } from "./memory-support.js";
import { benefitsFromState, catalogFromState } from "./memory-view.js";
import type { MemberBenefitsStore } from "./types.js";

export type CreateMemoryMemberBenefitsOptions = Readonly<{
  orgId: string;
  memberStore: MemberStore;
  orderStore: OrderStore;
  newId?: () => string;
}>;

export function createMemoryMemberBenefitsStore(
  options: CreateMemoryMemberBenefitsOptions,
): MemberBenefitsStore {
  let state: MemoryBenefitsState = EMPTY_MEMORY_BENEFITS_STATE;
  const context: MemoryBenefitsContext = Object.freeze({
    orgId: options.orgId,
    memberStore: options.memberStore,
    orderStore: options.orderStore,
    newId: options.newId ?? randomUUID,
    read: () => state,
    write: (next) => {
      state = next;
    },
  });

  return Object.freeze({
    upsertDefinition: (input) => upsertMemoryDefinition(context, input),
    setMembership: (input) => setMemoryMembership(context, input),
    earnPoints: (input) => earnMemoryPoints(context, input),
    redeemPoints: (input) => redeemMemoryPoints(context, input),
    grantAsset: (input) => grantMemoryAsset(context, input),
    consumePunch: (input) => consumeMemoryPunch(context, input),
    consumeCoupon: (input) => consumeMemoryCoupon(context, input),
    reverseCouponForOrder: (input) => reverseMemoryCouponForOrder(context, input),
    getCatalog: async (includeRetired) => catalogFromState(state, includeRetired),
    getBenefits: async (input) => {
      const account = await options.memberStore.getByCustomer(input.customer_id, 0);
      if (account === null) return rejectBenefit("account_not_found");
      return Object.freeze({
        ok: true as const,
        value: benefitsFromState(
          state,
          account.account,
          input.business_date,
          input.include_expired,
        ),
      });
    },
    resolveOrderMembership: async (customerId, businessDate) => {
      const account = await options.memberStore.getByCustomer(customerId, 0);
      if (account === null || account.account.status !== "active") return null;
      const membership = state.memberships.get(account.account.account_id);
      if (membership === undefined) return null;
      const tier =
        membership.tier !== null &&
        membership.valid_until !== null &&
        membership.valid_until >= businessDate
          ? membership.tier
          : null;
      return Object.freeze({ version: membership.version, tier });
    },
  });
}
