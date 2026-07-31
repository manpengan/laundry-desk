import { planRefundPayment } from "@laundry/domain";

import type { SqlClient } from "../db/types.js";
import { loadGarments, loadOrder, nextOrderStatus } from "./pg-order-data.js";
import { epochToDate } from "./pg-order-mappers.js";
import { insertLedgerPayment, listPaymentRows } from "./pg-order-operations.js";
import type { PaymentAppendResult, PaymentRefundAppendInput } from "./types.js";

export async function appendRefundTxn(
  client: SqlClient,
  input: PaymentRefundAppendInput,
  newId: () => string,
): Promise<PaymentAppendResult | null> {
  const order = await loadOrder(client, input.org_id, input.store_id, input.order_id, true);
  if (order === null || (order.status !== "open" && order.status !== "closed")) {
    return null;
  }
  const payments = await listPaymentRows(client, input.org_id, input.store_id, input.order_id);
  const referenced = payments.find((payment) => payment.payment_id === input.ref_payment_id);
  if (referenced === undefined || referenced.method !== input.expected_method) return null;
  const plan = planRefundPayment({
    payment_id: newId(),
    org_id: input.org_id,
    store_id: input.store_id,
    order_id: input.order_id,
    amount_cents: input.amount_cents,
    staff_id: input.staff_id,
    at: input.at,
    method: referenced.method,
    payable_cents: order.payable_cents,
    existing_payments: payments,
    ref_payment_id: input.ref_payment_id,
    reason: input.reason,
  });
  if (!plan.ok) return null;
  const payment = Object.freeze({
    ...plan.payment,
    business_date: input.business_date,
  });
  await insertLedgerPayment(client, payment, input.business_date);
  const garments = await loadGarments(client, input.org_id, input.store_id, input.order_id, true);
  const status = nextOrderStatus(garments, plan.balance_cents);
  await client.query(
    `UPDATE orders
     SET paid_cents = $4, balance_cents = $5, status = $6, updated_at = $7
     WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
    [
      input.org_id,
      input.store_id,
      input.order_id,
      plan.paid_cents,
      plan.balance_cents,
      status,
      epochToDate(input.at),
    ],
  );
  return Object.freeze({
    order: Object.freeze({
      ...order,
      paid_cents: plan.paid_cents,
      balance_cents: plan.balance_cents,
      status,
      updated_at: input.at,
    }),
    payment,
  });
}
