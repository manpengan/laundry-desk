/**
 * Decides which command settles a counter payment and with what body.
 *
 * Extracted from the dialog so the money-routing decision is unit-testable:
 * picking stored value must switch commands, never submit `payment.collect`
 * with a `balance` tender (ADR-17 §6).
 */

/** Sentinel for the stored-value choice in the method select. */
export const BALANCE_CHOICE = "__member_balance__";

export type PaymentSubmissionInput = Readonly<{
  /** `payment.collect` or `payment.repay`, chosen from garment status. */
  ledgerCommand: "payment.collect" | "payment.repay";
  orderId: string;
  orderBalanceCents: number;
  amountCents: number | null;
  method: string;
  note: string;
  memberAccountId: string | null;
  memberBalanceCents: number;
}>;

export type PaymentSubmissionRejectReason =
  | "invalid_amount"
  | "exceeds_order_balance"
  | "exceeds_member_balance"
  | "note_too_long"
  | "member_account_missing";

export type PaymentSubmission =
  | Readonly<{
      ok: true;
      command: "payment.collect" | "payment.repay" | "member.balance.pay";
      usesBalance: boolean;
      body: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{ ok: false; reason: PaymentSubmissionRejectReason }>;

const NOTE_MAX = 256;

export function buildPaymentSubmission(input: PaymentSubmissionInput): PaymentSubmission {
  const amount = input.amountCents;
  if (amount === null || !Number.isSafeInteger(amount) || amount <= 0) {
    return Object.freeze({ ok: false as const, reason: "invalid_amount" as const });
  }
  if (amount > input.orderBalanceCents) {
    return Object.freeze({ ok: false as const, reason: "exceeds_order_balance" as const });
  }
  const note = input.note.trim();
  if (note.length > NOTE_MAX) {
    return Object.freeze({ ok: false as const, reason: "note_too_long" as const });
  }
  const notePart = note.length === 0 ? {} : { note };

  if (input.method !== BALANCE_CHOICE) {
    return Object.freeze({
      ok: true as const,
      command: input.ledgerCommand,
      usesBalance: false,
      body: Object.freeze({
        order_id: input.orderId,
        amount_cents: amount,
        method: input.method,
        ...notePart,
      }),
    });
  }

  // Stored value selected. Without an account id there is nothing to debit, so
  // refuse rather than fall back to a tendered payment the member never made.
  if (input.memberAccountId === null) {
    return Object.freeze({ ok: false as const, reason: "member_account_missing" as const });
  }
  if (amount > input.memberBalanceCents) {
    return Object.freeze({ ok: false as const, reason: "exceeds_member_balance" as const });
  }
  return Object.freeze({
    ok: true as const,
    command: "member.balance.pay" as const,
    usesBalance: true,
    body: Object.freeze({
      account_id: input.memberAccountId,
      order_id: input.orderId,
      amount_cents: amount,
      ...notePart,
    }),
  });
}

export function submissionErrorMessage(reason: PaymentSubmissionRejectReason): string {
  switch (reason) {
    case "invalid_amount":
      return "收款金额须为正整数分";
    case "exceeds_order_balance":
      return "收款不能超过当前欠款";
    case "exceeds_member_balance":
      return "超过会员可用余额";
    case "note_too_long":
      return "备注不能超过 256 个字符";
    case "member_account_missing":
      return "会员账户不可用，请重新选择付款方式";
  }
}
