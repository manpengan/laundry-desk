import { buildReversalPayment, planCancel } from "@laundry/domain";
import type { SqlClient } from "../db/types.js";
import {
  lockCancellationAccounts,
  reversePgMemberOrderPayments,
} from "../member/pg-order-cancellation.js";
import { loadOrder, loadGarments } from "./pg-order-data.js";
import { epochToDate } from "./pg-order-mappers.js";
import { insertLedgerPayment } from "./pg-order-operations.js";
import { listPaymentRows } from "./pg-payment-rows.js";
import { isGarmentAvailableAtStore } from "./garment-custody.js";
import type { LedgerPaymentRow, OrderRecord } from "./types.js";

export async function cancelOrderTxn(
  client: SqlClient,
  orgId: string,
  storeId: string,
  orderId: string,
  reason: string,
  staffId: string,
  at: number,
  businessDate: string,
  newId: () => string,
  beforeCommit?: (reversals: readonly LedgerPaymentRow[]) => Promise<void>,
): Promise<OrderRecord | null> {
  const tenant = Object.freeze({ orgId, storeId, staffId });
  await lockCancellationAccounts(client, tenant, orderId);
  const order = await loadOrder(client, orgId, storeId, orderId, true);
  if (order === null || order.status !== "open") return null;
  const garments = await loadGarments(client, orgId, storeId, orderId, true);
  if (
    garments.some(
      (garment) =>
        !isGarmentAvailableAtStore(garment) ||
        garment.status === "picked_up" ||
        garment.status === "delivered",
    )
  ) {
    return null;
  }
  const payments = await listPaymentRows(client, orgId, storeId, orderId);
  const plan = planCancel({
    status: order.status,
    reason,
    payable_cents: order.payable_cents,
    payments,
  });
  if (!plan.ok) return null;
  const reversals: LedgerPaymentRow[] = [];
  for (const target of plan.reversal_targets) {
    const source = payments.find((payment) => payment.payment_id === target.payment_id);
    if (source === undefined) return null;
    reversals.push(
      Object.freeze({
        ...buildReversalPayment({
          payment_id: newId(),
          org_id: orgId,
          store_id: storeId,
          order_id: orderId,
          amount_cents: target.amount_cents,
          staff_id: staffId,
          at,
          method: source.method,
          ref_payment_id: source.payment_id,
          reason: plan.reason,
        }),
        business_date: businessDate,
      }),
    );
  }
  await reversePgMemberOrderPayments(
    client,
    tenant,
    {
      order_id: orderId,
      store_id: storeId,
      staff_id: staffId,
      at,
      business_date: businessDate,
      reason,
      reversals,
    },
    newId,
  );
  await beforeCommit?.(reversals);
  for (const reversal of reversals) {
    await insertLedgerPayment(client, reversal, businessDate);
  }
  await client.query(
    `UPDATE orders
     SET status = 'cancelled', paid_cents = 0, balance_cents = 0, updated_at = $4
     WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
    [orgId, storeId, orderId, epochToDate(at)],
  );
  return Object.freeze({
    ...order,
    status: "cancelled",
    paid_cents: 0,
    balance_cents: 0,
    updated_at: at,
  });
}
