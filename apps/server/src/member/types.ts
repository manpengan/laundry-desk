import type { MemberBalance } from "./balance.js";
import type { MemberAccountStatus } from "@laundry/domain";

export type { MemberAccountStatus } from "@laundry/domain";

export type MemberAccountRecord = Readonly<{
  account_id: string;
  customer_id: string;
  status: MemberAccountStatus;
  status_version: number;
  status_changed_at: number | null;
  status_reason: string | null;
  opened_at: number;
}>;

export type MemberLedgerKind = "topup" | "pay" | "reversal" | "refund" | "bonus_forfeit";

/**
 * How real money moved for this row (ADR-22 §1.1).
 *
 * Only rows that move money outside the ledger carry a tender: a top-up records
 * how the money came in. `kind = 'pay'` is always null — spending stored value
 * moves no cash, the cash arrived on the top-up day (ADR-18 §1).
 */
export type MemberTender = "cash" | "wechat" | "alipay" | "other";

export type MemberLedgerRow = Readonly<{
  ledger_id: string;
  kind: MemberLedgerKind;
  principal_delta_cents: number;
  bonus_delta_cents: number;
  order_id: string | null;
  store_id: string;
  tender: MemberTender | null;
  /**
   * Which bonus tier granted this top-up's bonus (ADR-22 §3.3).
   *
   * Snapshotted like an order's price: repricing or retiring a tier later must
   * not re-value a top-up that already happened. Null when no tier matched or
   * the row predates migration 0036.
   */
  bonus_rule_id: string | null;
  at: number;
  business_date: string;
  note: string | null;
}>;

export type MemberBonusRuleStatus = "active" | "retired";

export type MemberBonusRuleRecord = Readonly<{
  rule_id: string;
  min_topup_cents: number;
  bonus_cents: number;
  status: MemberBonusRuleStatus;
  updated_at: number;
  note: string | null;
}>;

export type MemberBonusRuleUpsertInput = Readonly<{
  /** Null creates a tier; a known id reprices or retires that exact tier. */
  rule_id: string | null;
  min_topup_cents: number;
  bonus_cents: number;
  status: MemberBonusRuleStatus;
  staff_id: string;
  at: number;
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
  /** Required: money entered the shop somehow, and the day's cash depends on it. */
  tender: MemberTender;
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

export type MemberRefundInput = Readonly<{
  account_id: string;
  store_id: string;
  amount_cents: number;
  /** How the money leaves. Cash refunds reduce the day's cash (ADR-22 §5.4). */
  tender: MemberTender;
  /** Required: money leaving the business must carry a human's reason. */
  reason: string;
  staff_id: string;
  at: number;
  business_date: string;
  note: string | null;
}>;

type MemberLifecycleBaseInput = Readonly<{
  account_id: string;
  expected_customer_id: string;
  expected_status_version: number;
  store_id: string;
  staff_id: string;
  at: number;
  reason: string;
}>;

export type MemberStatusTransitionInput = MemberLifecycleBaseInput &
  Readonly<{ action: "freeze" | "unfreeze" }>;

export type MemberCloseInput = MemberLifecycleBaseInput &
  Readonly<{
    expected_status: "active" | "frozen";
    expected_principal_cents: number;
    expected_bonus_cents: number;
    refund_tender: MemberTender | null;
    business_date: string;
  }>;

export type MemberLifecycleResult = Readonly<{
  account: MemberAccountRecord;
  previous_status: MemberAccountStatus;
  balance: MemberBalance;
  refunded_principal_cents: number;
  forfeited_bonus_cents: number;
  refund_ledger_id: string | null;
  bonus_forfeit_ledger_id: string | null;
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
  | "account_closed"
  | "account_customer_mismatch"
  | "account_version_conflict"
  | "invalid_transition"
  | "stale_status"
  | "stale_balance"
  | "invalid_balance"
  | "invalid_amount"
  | "insufficient_balance"
  | "bonus_rule_not_found";

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
  /**
   * Return unspent principal to the customer (ADR-22 §4, §5).
   *
   * Refundable is exactly the projected `principal_cents`, no retrospective
   * arithmetic: because spending always eats bonus first (ADR-17 §5), whatever
   * principal remains is precisely the part never consumed. The bonus itself is
   * never refundable — it is a book grant the customer never paid for.
   */
  refund: (input: MemberRefundInput) => Promise<MemberOutcome<MemberLedgerAppendResult>>;
  transitionStatus: (
    input: MemberStatusTransitionInput,
  ) => Promise<MemberOutcome<MemberLifecycleResult>>;
  close: (input: MemberCloseInput) => Promise<MemberOutcome<MemberLifecycleResult>>;
  /**
   * Cash that entered the drawer through stored value on one store-day (ADR-22 §1.2).
   *
   * Only `principal_delta_cents` of `tender = 'cash'` rows: a bonus is a book
   * grant with no banknote behind it, so counting it would make the drawer short
   * by exactly the bonus — the very kind of unexplained gap this closes.
   */
  sumCashPrincipal: (storeId: string, businessDate: string) => Promise<number>;
  /**
   * Create, reprice or retire one bonus tier (ADR-22 §2).
   *
   * Retiring is an UPDATE of `status`, not a new row: a tier is configuration,
   * not a money movement. The history that matters lives on the ledger, where
   * each top-up already snapshots the tier that granted it.
   */
  upsertBonusRule: (
    input: MemberBonusRuleUpsertInput,
  ) => Promise<MemberOutcome<MemberBonusRuleRecord>>;
  listBonusRules: (includeRetired: boolean) => Promise<readonly MemberBonusRuleRecord[]>;
}>;
