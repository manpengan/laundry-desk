/**
 * Order handler dependency bag (shared by command/query handlers).
 */

import type { CustomerStore } from "../customer/types.js";
import type { OrderStore } from "./types.js";

export type OrderHandlerDeps = Readonly<{
  store: OrderStore;
  /** When set, receive best-effort upserts customer by phone (never blocks open order). */
  customer?: CustomerStore;
  now?: () => number;
  newId?: () => string;
}>;
