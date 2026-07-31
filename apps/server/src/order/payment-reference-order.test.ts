import assert from "node:assert/strict";
import test from "node:test";

import { orderPaymentsByReference } from "./payment-reference-order.js";
import type { LedgerPaymentRow } from "./types.js";

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const STORE_ID = "00000000-0000-4000-8000-000000000002";
const ORDER_ID = "00000000-0000-4000-8000-000000000003";
const STAFF_ID = "00000000-0000-4000-8000-000000000004";
const SAME_SECOND = 1_722_355_200;

function payment(
  paymentId: string,
  kind: LedgerPaymentRow["kind"],
  refPaymentId: string | null = null,
  scope: Readonly<{
    orgId?: string;
    storeId?: string;
    orderId?: string;
  }> = {},
): LedgerPaymentRow {
  return Object.freeze({
    payment_id: paymentId,
    org_id: scope.orgId ?? ORG_ID,
    store_id: scope.storeId ?? STORE_ID,
    order_id: scope.orderId ?? ORDER_ID,
    method: "cash",
    amount_cents: 100,
    kind,
    ref_payment_id: refPaymentId,
    staff_id: STAFF_ID,
    at: SAME_SECOND,
    business_date: "2026-07-31",
    note: null,
  });
}

test("same-second refund is ordered after its lexically later referenced payment", () => {
  const source = payment("ffffffff-ffff-4fff-8fff-ffffffffffff", "repay");
  const refund = payment("00000000-0000-4000-8000-000000000010", "refund", source.payment_id);
  const sqlOrder = Object.freeze([refund, source]);

  const ordered = orderPaymentsByReference(sqlOrder);

  assert.deepEqual(
    ordered.map((row) => row.payment_id),
    [source.payment_id, refund.payment_id],
  );
  assert.deepEqual(sqlOrder, [refund, source]);
  assert.equal(Object.isFrozen(ordered), true);
});

test("dependency-first ordering follows a scrambled refund and reversal chain", () => {
  const source = payment("ffffffff-ffff-4fff-8fff-ffffffffffff", "pay");
  const refund = payment("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "refund", source.payment_id);
  const reversal = payment("00000000-0000-4000-8000-000000000010", "reversal", refund.payment_id);

  const ordered = orderPaymentsByReference(Object.freeze([reversal, refund, source]));

  assert.deepEqual(
    ordered.map((row) => row.payment_id),
    [source.payment_id, refund.payment_id, reversal.payment_id],
  );
});

test("independent rows keep their stable input order", () => {
  const first = payment("00000000-0000-4000-8000-000000000010", "pay");
  const second = payment("00000000-0000-4000-8000-000000000011", "repay");

  assert.deepEqual(orderPaymentsByReference(Object.freeze([first, second])), [first, second]);
});

test("missing payment references fail closed", () => {
  const refund = payment(
    "00000000-0000-4000-8000-000000000010",
    "refund",
    "00000000-0000-4000-8000-000000000099",
  );

  assert.throws(
    () => orderPaymentsByReference(Object.freeze([refund])),
    /Payment ledger reference graph is invalid/u,
  );
});

test("cyclic payment references fail closed", () => {
  const firstId = "00000000-0000-4000-8000-000000000010";
  const secondId = "00000000-0000-4000-8000-000000000011";
  const first = payment(firstId, "refund", secondId);
  const second = payment(secondId, "reversal", firstId);

  assert.throws(
    () => orderPaymentsByReference(Object.freeze([first, second])),
    /Payment ledger reference graph is invalid/u,
  );
});

test("references across org, store, or order scope fail closed", () => {
  const source = payment("00000000-0000-4000-8000-000000000010", "pay");
  const otherScopes = [
    payment("00000000-0000-4000-8000-000000000011", "refund", source.payment_id, {
      orgId: "00000000-0000-4000-8000-000000000021",
    }),
    payment("00000000-0000-4000-8000-000000000012", "refund", source.payment_id, {
      storeId: "00000000-0000-4000-8000-000000000022",
    }),
    payment("00000000-0000-4000-8000-000000000013", "refund", source.payment_id, {
      orderId: "00000000-0000-4000-8000-000000000023",
    }),
  ] as const;

  for (const otherScope of otherScopes) {
    assert.throws(
      () => orderPaymentsByReference(Object.freeze([source, otherScope])),
      /Payment ledger reference graph is invalid/u,
    );
  }
});

test("independent ledgers from multiple orders remain readable", () => {
  const first = payment("00000000-0000-4000-8000-000000000010", "pay");
  const second = payment("00000000-0000-4000-8000-000000000011", "pay", null, {
    orderId: "00000000-0000-4000-8000-000000000023",
  });

  assert.deepEqual(orderPaymentsByReference(Object.freeze([first, second])), [first, second]);
});

test("duplicate payment ids fail closed", () => {
  const paymentId = "00000000-0000-4000-8000-000000000010";
  const first = payment(paymentId, "pay");
  const duplicate = payment(paymentId, "repay");

  assert.throws(
    () => orderPaymentsByReference(Object.freeze([first, duplicate])),
    /Payment ledger reference graph is invalid/u,
  );
});
