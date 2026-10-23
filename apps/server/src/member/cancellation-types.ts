import type { LedgerPaymentRow } from "../order/types.js";

export type MemberPaymentLinkInput = Readonly<{
  account_id: string;
  ledger_id: string;
  payment_id: string;
  store_id: string;
  order_id: string;
  amount_cents: number;
}>;

export type MemberCancellationInput = Readonly<{
  order_id: string;
  store_id: string;
  staff_id: string;
  at: number;
  business_date: string;
  reason: string;
  reversals: readonly LedgerPaymentRow[];
}>;
