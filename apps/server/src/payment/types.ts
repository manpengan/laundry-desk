import type { PaymentRow } from "@laundry/domain";

/**
 * Append-only payment ledger repository. Scope comes from the authenticated
 * tenant context used to construct a row, never from command arguments.
 */
export type PaymentStore = Readonly<{
  listPayments: (orgId: string, storeId: string, orderId: string) => Promise<readonly PaymentRow[]>;
  appendPayment: (payment: PaymentRow) => Promise<void>;
}>;
