/**
 * Order handler dependency bag (shared by command/query handlers).
 */

import type { CustomerStore } from "../customer/types.js";
import type { CustomerOrderPolicyResolver } from "../customer-profile/order-policy.js";
import type { CatalogStore } from "../catalog/memory-catalog.js";
import type { SqlClient, TenantContext } from "../db/types.js";
import type { CouponCancellationStoreInput } from "../member-benefits/types.js";
import type { BusinessDayLockPort } from "../workday/business-day-lock.js";
import type { PricingPolicyStore } from "../pricing/types.js";
import type { OrderStore } from "./types.js";

export type OrderHandlerDeps = Readonly<{
  store: OrderStore;
  /** Authoritative active price list; received line prices never come from clients. */
  catalog?: CatalogStore;
  /** Store-scoped urgent/freight/add-on authority shared with pricing.policy.*. */
  pricing?: PricingPolicyStore;
  /** When set, receive atomically upserts the customer before persisting the order. */
  customer?: CustomerStore;
  /** Transaction-consistent ADR-42 profile/tier authority frozen onto new orders. */
  customerPolicy?: CustomerOrderPolicyResolver;
  now?: () => number;
  newId?: () => string;
  timeZone?: string;
  rolloverHour?: number;
  /** Reject business writes once the matching store day has a frozen close. */
  isBusinessDayClosed?: (businessDate: string) => Promise<boolean>;
  /** PG transaction-scoped serialization shared with shift.close. */
  lockBusinessDay?: BusinessDayLockPort;
  /** Append-only coupon return composed into order.cancel before persistence. */
  couponCancellation?: (
    client: SqlClient,
    tenant: TenantContext,
    input: CouponCancellationStoreInput,
  ) => Promise<void>;
}>;
