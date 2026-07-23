import { describe, expect, it } from "vitest";

import {
  buildPayPayment,
  buildReversalPayment,
  derivePaymentLedger,
  planCollectPayment,
  planRefundPayment,
  planRepayPayment,
  planReversalPayment,
} from "../payment.js";

const common = Object.freeze({
  org_id: "org-1",
  store_id: "store-1",
  order_id: "order-1",
  staff_id: "staff-1",
  at: 1_700_000_000,
  method: "cash" as const,
});

describe("append-only payment ledger", () => {
  it("builds a kind=pay cash row with positive cents", () => {
    const row = buildPayPayment({ ...common, payment_id: "pay-1", amount_cents: 2_500 });
    expect(row).toEqual({
      payment_id: "pay-1",
      org_id: "org-1",
      store_id: "store-1",
      order_id: "order-1",
      amount_cents: 2_500,
      staff_id: "staff-1",
      at: 1_700_000_000,
      method: "cash",
      kind: "pay",
      ref_payment_id: null,
      note: null,
    });
  });

  it("plans collection then repayment without allowing an overpayment", () => {
    const collect = planCollectPayment({
      ...common,
      payment_id: "pay-1",
      amount_cents: 400,
      payable_cents: 1_000,
      existing_payments: [],
    });
    expect(collect).toMatchObject({ ok: true, paid_cents: 400, balance_cents: 600 });
    if (!collect.ok) return;

    const repay = planRepayPayment({
      ...common,
      payment_id: "repay-1",
      amount_cents: 600,
      at: common.at + 1,
      payable_cents: 1_000,
      existing_payments: [collect.payment],
    });
    expect(repay).toMatchObject({ ok: true, payment: { kind: "repay" }, balance_cents: 0 });
    expect(
      planCollectPayment({
        ...common,
        payment_id: "too-much",
        amount_cents: 601,
        payable_cents: 1_000,
        existing_payments: [collect.payment],
      }),
    ).toEqual({ ok: false, reason: "AMOUNT_EXCEEDS_BALANCE" });
  });

  it("rebuilds paid and balance from a refund and its reversal", () => {
    const payment = buildPayPayment({ ...common, payment_id: "pay-1", amount_cents: 800 });
    const refund = planRefundPayment({
      ...common,
      payment_id: "refund-1",
      amount_cents: 300,
      at: common.at + 1,
      payable_cents: 1_000,
      existing_payments: [payment],
      ref_payment_id: payment.payment_id,
      reason: "customer changed service",
    });
    expect(refund).toMatchObject({ ok: true, paid_cents: 500, balance_cents: 500 });
    if (!refund.ok) return;

    const reversal = planReversalPayment({
      ...common,
      payment_id: "reversal-1",
      amount_cents: 300,
      at: common.at + 2,
      payable_cents: 1_000,
      existing_payments: [payment, refund.payment],
      ref_payment_id: refund.payment.payment_id,
      reason: "refund entry was mistaken",
    });
    expect(reversal).toMatchObject({ ok: true, paid_cents: 800, balance_cents: 200 });
    if (!reversal.ok) return;
    expect(derivePaymentLedger(1_000, [payment, refund.payment, reversal.payment])).toEqual({
      ok: true,
      paid_cents: 800,
      balance_cents: 200,
    });
  });

  it("requires a full red reversal and forbids silently invalid ledger rows", () => {
    const payment = buildPayPayment({ ...common, payment_id: "pay-1", amount_cents: 500 });
    expect(
      planReversalPayment({
        ...common,
        payment_id: "reversal-1",
        amount_cents: 499,
        at: common.at + 1,
        payable_cents: 1_000,
        existing_payments: [payment],
        ref_payment_id: payment.payment_id,
        reason: "incorrect amount",
      }),
    ).toEqual({ ok: false, reason: "REVERSAL_AMOUNT_MISMATCH" });
    expect(derivePaymentLedger(1_000, [{ ...payment, amount_cents: 0 }])).toEqual({
      ok: false,
      reason: "INVALID_PAYMENT",
    });
  });

  it("rejects non-positive direct payment construction", () => {
    expect(() => buildPayPayment({ ...common, payment_id: "pay-1", amount_cents: 0 })).toThrow(
      /positive safe integer/u,
    );
    expect(() =>
      buildReversalPayment({
        ...common,
        payment_id: "reverse-1",
        amount_cents: 1,
        ref_payment_id: "pay-1",
        reason: " ",
      }),
    ).toThrow(/reason/u);
  });
});
