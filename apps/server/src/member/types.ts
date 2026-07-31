import type { MemberBalance } from "./balance.js";

export type MemberAccountStatus = "active" | "frozen";

export type MemberAccountRecord = Readonly<{
  account_id: string;
  customer_id: string;
  status: MemberAccountStatus;
  opened_at: number;
}>;

export type MemberLedgerKind = "topup" | "pay" | "reversal";

export type MemberLedgerRow = Readonly<{
  ledger_id: string;
  kind: MemberLedgerKind;
  principal_delta_cents: number;
  bonus_delta_cents: number;
  order_id: string | null;
  store_id: string;
  at: number;
  business_date: string;
  note: string | null;
}>;

export type MemberAccountView = Readonly<{
  account: MemberAccountRecord;
  balance: MemberBalance;
  recent: readonly MemberLedgerRow[];
}>;

export type MemberOpenInput = Readonly<{
  customer_id: string;
  store_id: string;
  at: number;
}>;

export type MemberOpenResult = Readonly<{
  account: MemberAccountRecord;
  /** False when the account already existed — open is idempotent per customer. */
  created: boolean;
}>;

export type MemberTopupInput = Readonly<{
  account_id: string;
  store_id: string;
  amount_cents: number;
  staff_id: string;
  at: number;
  business_date: string;
  note: string | null;
}>;

export type MemberSpendInput = Readonly<{
  account_id: string;
  store_id: string;
  order_id: string;
  amount_cents: number;
  staff_id: string;
  at: number;
  business_date: string;
  note: string | null;
}>;

export type MemberLedgerAppendResult = Readonly<{
  account_id: string;
  ledger_id: string;
  balance: MemberBalance;
  principal_delta_cents: number;
  bonus_delta_cents: number;
}>;

/**
 * Why a store operation refused.
 *
 * Every one of these is a refusal, never a partial write: the caller runs inside
 * a transaction and is expected to abort on anything other than success.
 */
export type MemberRejectReason =
  | "customer_not_found"
  | "account_not_found"
  | "account_frozen"
  | "invalid_amount"
  | "insufficient_balance";

export type MemberOutcome<TValue> =
  Readonly<{ ok: true; value: TValue }> | Readonly<{ ok: false; reason: MemberRejectReason }>;

export type MemberStore = Readonly<{
  openAccount: (input: MemberOpenInput) => Promise<MemberOutcome<MemberOpenResult>>;
  getByCustomer: (customerId: string, limit: number) => Promise<MemberAccountView | null>;
  topup: (input: MemberTopupInput) => Promise<MemberOutcome<MemberLedgerAppendResult>>;
  /**
   * Debit the balance for an order.
   *
   * Only the ledger side. The order-side payment row is appended by the caller
   * in the same transaction so the existing, tested order accounting stays the
   * single owner of paid_cents / status (ADR-17 §6).
   */
  spend: (input: MemberSpendInput) => Promise<MemberOutcome<MemberLedgerAppendResult>>;
}>;
