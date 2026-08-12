import { randomUUID } from "node:crypto";

import type { SqlClient, TenantContext } from "../db/types.js";
import { consumePgCoupon, consumePgPunch, grantPgAsset } from "./pg-assets.js";
import { readPgBenefitCatalog, upsertPgBenefitDefinition } from "./pg-catalog.js";
import { reversePgCouponForOrder } from "./pg-coupon-reversal.js";
import { setPgMembership } from "./pg-membership.js";
import { readPgOrderMembership } from "./pg-order-membership.js";
import { earnPgPoints, redeemPgPoints } from "./pg-points.js";
import { readBenefitAccountByCustomer, rejectPgBenefit } from "./pg-support.js";
import { readPgMemberBenefits } from "./pg-view.js";
import type { MemberBenefitsStore } from "./types.js";

export type CreatePgMemberBenefitsStoreOptions = Readonly<{ newId?: () => string }>;

export function createPgMemberBenefitsStore(
  client: SqlClient,
  tenant: TenantContext,
  options: CreatePgMemberBenefitsStoreOptions = {},
): MemberBenefitsStore {
  const newId = options.newId ?? randomUUID;
  return Object.freeze({
    upsertDefinition: (input) => upsertPgBenefitDefinition(client, tenant, input, newId),
    setMembership: (input) => setPgMembership(client, tenant, input),
    earnPoints: (input) => earnPgPoints(client, tenant, input, newId),
    redeemPoints: (input) => redeemPgPoints(client, tenant, input, newId),
    grantAsset: (input) => grantPgAsset(client, tenant, input, newId),
    consumePunch: (input) => consumePgPunch(client, tenant, input, newId),
    consumeCoupon: (input) => consumePgCoupon(client, tenant, input, newId),
    reverseCouponForOrder: (input) => reversePgCouponForOrder(client, tenant, input, newId),
    getCatalog: (includeRetired) => readPgBenefitCatalog(client, tenant, includeRetired),
    getBenefits: async (input) => {
      const account = await readBenefitAccountByCustomer(client, tenant, input.customer_id);
      if (account === null) return rejectPgBenefit("account_not_found");
      return Object.freeze({
        ok: true as const,
        value: await readPgMemberBenefits(
          client,
          tenant,
          account,
          input.business_date,
          input.include_expired,
        ),
      });
    },
    resolveOrderMembership: (customerId, businessDate) =>
      readPgOrderMembership(client, tenant, customerId, businessDate),
  });
}
