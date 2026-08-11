import assert from "node:assert/strict";
import test from "node:test";

import type { CommandPort } from "../commands/types.js";
import {
  buildPaymentRefundBody,
  readPaymentLedger,
  resumePaymentRefund,
} from "./payment-ledger-model.js";

const ORDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PAYMENT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REFUND_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const LEDGER = {
  execution: "executed",
  result: {
    order_id: ORDER_ID,
    order_status: "open",
    payable_cents: 4_000,
    paid_cents: 800,
    balance_cents: 3_200,
    payments: [
      {
        payment_id: PAYMENT_ID,
        kind: "pay",
        method: "cash",
        amount_cents: 1_000,
        signed_cents: 1_000,
        ref_payment_id: null,
        at: 1_700_000_000,
        note: null,
        active: true,
        refundable_cents: 800,
      },
      {
        payment_id: REFUND_ID,
        kind: "refund",
        method: "cash",
        amount_cents: 200,
        signed_cents: -200,
        ref_payment_id: PAYMENT_ID,
        at: 1_700_000_001,
        note: "改项退款",
        active: true,
        refundable_cents: 0,
      },
    ],
  },
};

test("payment ledger parser freezes the exact server projection", () => {
  const parsed = readPaymentLedger(LEDGER);
  assert.ok(parsed);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.payments), true);
  assert.equal(Object.isFrozen(parsed.payments[0]), true);
  assert.equal(parsed.payments[0]?.refundable_cents, 800);
});

test("payment ledger parser rejects extra fields and invalid signed authority", () => {
  assert.equal(
    readPaymentLedger({
      ...LEDGER,
      result: { ...LEDGER.result, payments: [{ ...LEDGER.result.payments[0], secret: "no" }] },
    }),
    null,
  );
  assert.equal(
    readPaymentLedger({
      ...LEDGER,
      result: { ...LEDGER.result, paid_cents: 801, balance_cents: 3_199 },
    }),
    null,
  );
  assert.equal(
    readPaymentLedger({
      ...LEDGER,
      result: {
        ...LEDGER.result,
        payments: [LEDGER.result.payments[0], LEDGER.result.payments[0]],
        paid_cents: 2_000,
        balance_cents: 2_000,
      },
    }),
    null,
  );
  assert.equal(
    readPaymentLedger({
      ...LEDGER,
      result: {
        ...LEDGER.result,
        payments: [{ ...LEDGER.result.payments[0], signed_cents: -1_000 }],
      },
    }),
    null,
  );
});

test("payment ledger parser accepts the zeroed projection of a cancelled order", () => {
  const cancelled = readPaymentLedger({
    ...LEDGER,
    result: {
      ...LEDGER.result,
      order_status: "cancelled",
      paid_cents: 0,
      balance_cents: 0,
      payments: [
        { ...LEDGER.result.payments[0], refundable_cents: 0, active: false },
        {
          ...LEDGER.result.payments[1],
          kind: "reversal",
          amount_cents: 1_000,
          signed_cents: -1_000,
          ref_payment_id: PAYMENT_ID,
          active: false,
        },
      ],
    },
  });
  assert.ok(cancelled);
  assert.equal(cancelled.order_status, "cancelled");
});

test("refund body derives immutable method and payment id from the selected server row", () => {
  const ledger = readPaymentLedger(LEDGER);
  assert.ok(ledger);
  const built = buildPaymentRefundBody(ORDER_ID, ledger.payments[0]!, "250", "  顾客改项  ");
  assert.deepEqual(built, {
    ok: true,
    body: {
      order_id: ORDER_ID,
      amount_cents: 250,
      method: "cash",
      ref_payment_id: PAYMENT_ID,
      reason: "顾客改项",
    },
  });
  assert.equal(buildPaymentRefundBody(ORDER_ID, ledger.payments[0]!, "801", "超额").ok, false);
  assert.equal(buildPaymentRefundBody(ORDER_ID, ledger.payments[1]!, "1", "重复").ok, false);
});

test("R4 continuation sends only the frozen confirmation reference", async () => {
  const calls: unknown[] = [];
  const client: CommandPort = Object.freeze({
    execute: async <T = unknown>(
      name: string,
      body: unknown = {},
      options: Readonly<{ confirmRef?: string }> = {},
    ) => {
      calls.push(Object.freeze({ name, body, options }));
      return Object.freeze({ ok: true as const, data: Object.freeze({}) as T });
    },
  });
  await resumePaymentRefund(client, "refund-confirm-ref");
  assert.deepEqual(calls, [
    { name: "payment.refund", body: {}, options: { confirmRef: "refund-confirm-ref" } },
  ]);
});
