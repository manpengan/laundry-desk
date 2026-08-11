import { describe, expect, it } from "vitest";

import {
  buildPayPayment,
  buildReversalPayment,
  derivePaymentLedger,
  projectPaymentLedger,
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

  it("plans the balance ledger row used by the transactional member-spend path", () => {
    const result = planCollectPayment({
      ...common,
      payment_id: "balance-pay-1",
      method: "balance",
      amount_cents: 600,
      payable_cents: 1_000,
      existing_payments: [],
    });

    expect(result).toMatchObject({
      ok: true,
      payment: { method: "balance", kind: "pay" },
      paid_cents: 600,
      balance_cents: 400,
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

  it("projects signed rows and server-derived remaining refundability", () => {
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
    expect(refund.ok).toBe(true);
    if (!refund.ok) return;

    expect(projectPaymentLedger(1_000, [payment, refund.payment])).toEqual({
      ok: true,
      paid_cents: 500,
      balance_cents: 500,
      rows: [
        { ...payment, active: true, signed_cents: 800, refundable_cents: 500 },
        { ...refund.payment, active: true, signed_cents: -300, refundable_cents: 0 },
      ],
    });
  });

  it("restores refundability after reversing a refund and never exposes balance tender", () => {
    const payment = buildPayPayment({ ...common, payment_id: "pay-1", amount_cents: 800 });
    const balancePayment = buildPayPayment({
      ...common,
      payment_id: "balance-1",
      amount_cents: 100,
      method: "balance",
      at: common.at + 1,
    });
    const refund = planRefundPayment({
      ...common,
      payment_id: "refund-1",
      amount_cents: 300,
      at: common.at + 2,
      payable_cents: 1_000,
      existing_payments: [payment, balancePayment],
      ref_payment_id: payment.payment_id,
      reason: "customer changed service",
    });
    expect(refund.ok).toBe(true);
    if (!refund.ok) return;
    const reversal = planReversalPayment({
      ...common,
      payment_id: "reversal-1",
      amount_cents: 300,
      at: common.at + 3,
      payable_cents: 1_000,
      existing_payments: [payment, balancePayment, refund.payment],
      ref_payment_id: refund.payment.payment_id,
      reason: "refund entry was mistaken",
    });
    expect(reversal.ok).toBe(true);
    if (!reversal.ok) return;

    const projection = projectPaymentLedger(1_000, [
      payment,
      balancePayment,
      refund.payment,
      reversal.payment,
    ]);
    expect(projection).toMatchObject({
      ok: true,
      paid_cents: 900,
      balance_cents: 100,
      rows: [
        { payment_id: "pay-1", active: true, refundable_cents: 800 },
        { payment_id: "balance-1", active: true, refundable_cents: 0 },
        { payment_id: "refund-1", active: false, signed_cents: -300 },
        { payment_id: "reversal-1", active: false, signed_cents: 300 },
      ],
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
