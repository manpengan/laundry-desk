/**
 * Order handler dependency bag (shared by command/query handlers).
 */

import type { CustomerStore } from "../customer/types.js";
import type { CatalogStore } from "../catalog/memory-catalog.js";
import type { BusinessDayLockPort } from "../workday/business-day-lock.js";
import type { OrderStore } from "./types.js";

export type OrderHandlerDeps = Readonly<{
  store: OrderStore;
  /** Authoritative active price list; received line prices never come from clients. */
  catalog?: CatalogStore;
  /** When set, receive atomically upserts the customer before persisting the order. */
  customer?: CustomerStore;
  now?: () => number;
  newId?: () => string;
  timeZone?: string;
  rolloverHour?: number;
  /** Reject business writes once the matching store day has a frozen close. */
  isBusinessDayClosed?: (businessDate: string) => Promise<boolean>;
  /** PG transaction-scoped serialization shared with shift.close. */
  lockBusinessDay?: BusinessDayLockPort;
}>;
