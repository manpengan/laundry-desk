import assert from "node:assert/strict";
import test from "node:test";

import type { LedgerPaymentRow, OrderRecord } from "../order/types.js";
import { snapshotFromOrder } from "./snapshot.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const STORE_ID = "00000000-0000-4000-8000-000000000002";
const ORDER_ID = "00000000-0000-4000-8000-000000000003";
const STAFF_ID = "00000000-0000-4000-8000-000000000004";

const ORDER = Object.freeze({
  order_id: ORDER_ID,
  org_id: ORG_ID,
  store_id: STORE_ID,
  ticket_no: "20260801-0001",
  pickup_code: "123456",
  status: "open",
  customer_id: null,
  customer_phone: null,
  customer_name: null,
  note: null,
  lines: Object.freeze([
    Object.freeze({
      line_index: 0,
      service_code: "wash",
      category_code: "shirt",
      unit_price_cents: 500,
      qty: 1,
      line_total_cents: 500,
      color: null,
      brand: null,
    }),
  ]),
  subtotal_cents: 500,
  original_cents: 500,
  discount_cents: 0,
  addon_cents: 0,
  urgent_cents: 0,
  freight_cents: 0,
  payable_cents: 500,
  paid_cents: 200,
  balance_cents: 300,
  created_at: 1_754_000_000,
  updated_at: 1_754_000_000,
  business_date: "2026-08-01",
  created_by_staff_id: STAFF_ID,
} satisfies OrderRecord);

function payment(
  paymentId: string,
  method: LedgerPaymentRow["method"],
  kind: LedgerPaymentRow["kind"],
  amountCents: number,
  refPaymentId: string | null = null,
): LedgerPaymentRow {
  return Object.freeze({
    payment_id: paymentId,
    org_id: ORG_ID,
    store_id: STORE_ID,
    order_id: ORDER_ID,
    method,
    amount_cents: amountCents,
    kind,
    ref_payment_id: refPaymentId,
    staff_id: STAFF_ID,
    at: 1_754_000_000,
    note: null,
  });
}

test("payment reversals cancel the referenced method, not the reversal row method", () => {
  const wechat = payment("00000000-0000-4000-8000-000000000010", "wechat", "pay", 300);
  const reversal = payment(
    "00000000-0000-4000-8000-000000000011",
    "cash",
    "reversal",
    300,
    wechat.payment_id,
  );
  const cash = payment("00000000-0000-4000-8000-000000000012", "cash", "repay", 200);

  const snapshot = snapshotFromOrder({
    order: ORDER,
    storeName: "Test Laundry",
    storePhone: null,
    payments: Object.freeze([wechat, reversal, cash]),
  });

  assert.deepEqual(snapshot.payment_methods, ["cash"]);
});

test("a reversal whose referenced ledger row is absent fails closed", () => {
  const reversal = payment(
    "00000000-0000-4000-8000-000000000011",
    "cash",
    "reversal",
    300,
    "00000000-0000-4000-8000-000000000099",
  );

  assert.throws(
    () =>
      snapshotFromOrder({
        order: ORDER,
        storeName: "Test Laundry",
        storePhone: null,
        payments: Object.freeze([reversal]),
      }),
    /missing its referenced ledger row/u,
  );
});
