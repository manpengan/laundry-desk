import assert from "node:assert/strict";
import test from "node:test";

import {
  BALANCE_CHOICE,
  buildPaymentSubmission,
  submissionErrorMessage,
  type PaymentSubmissionInput,
} from "./payment-submission.js";

const ORDER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ACCOUNT_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const base: PaymentSubmissionInput = Object.freeze({
  ledgerCommand: "payment.collect",
  orderId: ORDER_ID,
  orderBalanceCents: 2_500,
  amountCents: 1_000,
  method: "cash",
  note: "",
  memberAccountId: ACCOUNT_ID,
  memberBalanceCents: 5_000,
});

const withInput = (patch: Partial<PaymentSubmissionInput>): PaymentSubmissionInput =>
  Object.freeze({ ...base, ...patch });

test("a tendered payment keeps the ledger command and its method", () => {
  const result = buildPaymentSubmission(withInput({ method: "wechat" }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.command, "payment.collect");
  assert.equal(result.usesBalance, false);
  assert.deepEqual(result.body, {
    order_id: ORDER_ID,
    amount_cents: 1_000,
    method: "wechat",
  });
});

test("repayment keeps its own ledger command", () => {
  const result = buildPaymentSubmission(withInput({ ledgerCommand: "payment.repay" }));

  assert.equal(result.ok && result.command, "payment.repay");
});

test("stored value switches the command instead of tendering `balance`", () => {
  const result = buildPaymentSubmission(withInput({ method: BALANCE_CHOICE }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.command, "member.balance.pay");
  assert.equal(result.usesBalance, true);
  // The body must name the account to debit and must NOT carry a `method`:
  // a payment.collect with method=balance would credit the order with no
  // matching ledger debit (ADR-17 §6).
  assert.deepEqual(result.body, {
    account_id: ACCOUNT_ID,
    order_id: ORDER_ID,
    amount_cents: 1_000,
  });
  assert.equal("method" in result.body, false);
});

test("no tendered payment ever carries the balance sentinel as a method", () => {
  for (const method of ["cash", "wechat", "alipay", "other"]) {
    const result = buildPaymentSubmission(withInput({ method }));
    assert.equal(result.ok, true);
    if (!result.ok) continue;
    assert.notEqual(result.body.method, BALANCE_CHOICE);
    assert.notEqual(result.body.method, "balance");
  }
});

test("stored value is refused when no account is loaded", () => {
  const result = buildPaymentSubmission(
    withInput({ method: BALANCE_CHOICE, memberAccountId: null }),
  );

  assert.deepEqual(result, { ok: false, reason: "member_account_missing" });
});

test("stored value is refused beyond the member balance", () => {
  const result = buildPaymentSubmission(
    withInput({ method: BALANCE_CHOICE, amountCents: 5_001, orderBalanceCents: 9_000 }),
  );

  assert.deepEqual(result, { ok: false, reason: "exceeds_member_balance" });
});

test("stored value may spend the member balance down to exactly zero", () => {
  const result = buildPaymentSubmission(
    withInput({ method: BALANCE_CHOICE, amountCents: 5_000, orderBalanceCents: 9_000 }),
  );

  assert.equal(result.ok && result.body.amount_cents, 5_000);
});

test("any payment is refused beyond the order balance", () => {
  for (const method of ["cash", BALANCE_CHOICE]) {
    const result = buildPaymentSubmission(withInput({ method, amountCents: 2_501 }));
    assert.deepEqual(result, { ok: false, reason: "exceeds_order_balance" }, method);
  }
});

test("zero, negative and non-integer amounts are refused", () => {
  for (const amount of [0, -1, 1.5, null]) {
    const result = buildPaymentSubmission(withInput({ amountCents: amount }));
    assert.deepEqual(result, { ok: false, reason: "invalid_amount" }, String(amount));
  }
});

test("a note is trimmed, omitted when empty and refused when too long", () => {
  const trimmed = buildPaymentSubmission(withInput({ note: "  预付  " }));
  assert.equal(trimmed.ok && trimmed.body.note, "预付");

  const empty = buildPaymentSubmission(withInput({ note: "   " }));
  assert.equal(empty.ok && "note" in empty.body, false);

  const long = buildPaymentSubmission(withInput({ note: "x".repeat(257) }));
  assert.deepEqual(long, { ok: false, reason: "note_too_long" });
});

test("every reject reason has a distinct human message", () => {
  const reasons = [
    "invalid_amount",
    "exceeds_order_balance",
    "exceeds_member_balance",
    "note_too_long",
    "member_account_missing",
  ] as const;
  const messages = reasons.map(submissionErrorMessage);

  assert.equal(new Set(messages).size, reasons.length);
  assert.equal(
    messages.every((message) => message.length > 0),
    true,
  );
});
