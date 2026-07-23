import { describe, expect, it } from "vitest";

import { planCancel } from "../cancel-plan.js";
import { planHold, planResume } from "../hold-plan.js";
import {
  buildPayPayment,
  buildRefundPayment,
  buildReversalPayment,
  derivePaymentLedger,
} from "../payment.js";

const paymentBase = Object.freeze({
  org_id: "org-1",
  store_id: "store-1",
  order_id: "order-1",
  staff_id: "staff-1",
  method: "cash" as const,
  at: 100,
});

describe("hold and cancel plans", () => {
  it("keeps a held frozen-v0.2 order open, never draft", () => {
    expect(planHold({ status: "open", reason: " customer wants to add an item " })).toEqual({
      ok: true,
      order_status: "open",
      held: true,
      reason: "customer wants to add an item",
    });
    expect(planHold({ status: "closed", reason: "too late" })).toEqual({
      ok: false,
      reason: "ORDER_NOT_OPEN",
    });
    expect(planResume({ status: "open", held: true })).toEqual({
      ok: true,
      order_status: "open",
      held: false,
    });
  });

  it("requires reason and produces newest-first cancellation reversals", () => {
    const pay = buildPayPayment({ ...paymentBase, payment_id: "pay-1", amount_cents: 800 });
    const refund = buildRefundPayment({
      ...paymentBase,
      payment_id: "refund-1",
      amount_cents: 300,
      at: 101,
      ref_payment_id: pay.payment_id,
      reason: "partial refund",
    });
    const plan = planCancel({
      status: "open",
      reason: " customer cancelled ",
      payable_cents: 1_000,
      payments: [pay, refund],
    });
    expect(plan).toEqual({
      ok: true,
      status: "cancelled",
      reason: "customer cancelled",
      reversal_targets: [
        { payment_id: "refund-1", amount_cents: 300, kind: "refund" },
        { payment_id: "pay-1", amount_cents: 800, kind: "pay" },
      ],
    });
  });

  it("lets the cancellation reversal plan reduce a paid ledger to zero", () => {
    const pay = buildPayPayment({ ...paymentBase, payment_id: "pay-1", amount_cents: 800 });
    const refund = buildRefundPayment({
      ...paymentBase,
      payment_id: "refund-1",
      amount_cents: 300,
      at: 101,
      ref_payment_id: pay.payment_id,
      reason: "partial refund",
    });
    const reverseRefund = buildReversalPayment({
      ...paymentBase,
      payment_id: "reverse-refund-1",
      amount_cents: 300,
      at: 102,
      ref_payment_id: refund.payment_id,
      reason: "cancel order",
    });
    const reversePay = buildReversalPayment({
      ...paymentBase,
      payment_id: "reverse-pay-1",
      amount_cents: 800,
      at: 103,
      ref_payment_id: pay.payment_id,
      reason: "cancel order",
    });
    expect(derivePaymentLedger(1_000, [pay, refund, reverseRefund, reversePay])).toEqual({
      ok: true,
      paid_cents: 0,
      balance_cents: 1_000,
    });
  });

  it("does not cancel an already closed order or omit the audit reason", () => {
    expect(
      planCancel({ status: "closed", reason: "reason", payable_cents: 0, payments: [] }),
    ).toEqual({
      ok: false,
      reason: "ORDER_NOT_OPEN",
    });
    expect(planCancel({ status: "open", reason: " ", payable_cents: 0, payments: [] })).toEqual({
      ok: false,
      reason: "INVALID_REASON",
    });
  });
});
