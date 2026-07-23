/**
 * Order handler dependency bag (shared by command/query handlers).
 */

import type { CustomerStore } from "../customer/types.js";
import type { PaymentStore } from "../payment/types.js";
import type { OrderStore } from "./types.js";

export type OrderHandlerDeps = Readonly<{
  store: OrderStore;
  /** Shared append-only payment ledger for receipt deposits and pickup collection. */
  payments?: PaymentStore;
  /** When set, receive atomically upserts the customer before persisting the order. */
  customer?: CustomerStore;
  now?: () => number;
  newId?: () => string;
}>;
