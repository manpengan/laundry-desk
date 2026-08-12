/** PostgreSQL order mutations that also maintain the append-only payment ledger. */
import {
  buildPayPayment,
  buildReversalPayment,
  planCancel,
  planCollectPayment,
  planRepayPayment,
} from "@laundry/domain";

import type { SqlClient } from "../db/types.js";
import { assertPickupPlanMatchesCurrentRows, markGarmentsPickedUp } from "./pg-garment-pickup.js";
import { requireVerifiedRackBarcodes } from "./pickup-verification.js";
import { buildLineIdByIndex, epochToDate } from "./pg-order-mappers.js";
import {
  insertOrderChildren,
  insertOrderRows,
  loadGarments,
  loadOrder,
  nextOrderStatus,
} from "./pg-order-data.js";
import { isGarmentAvailableAtStore } from "./garment-custody.js";
import { listPaymentRows } from "./pg-payment-rows.js";
import type {
  InitialPayment,
  LedgerPaymentRow,
  OrderRecord,
  PaymentAppendInput,
  PaymentAppendResult,
  PickupApplyOptions,
  PickupApplyResult,
} from "./types.js";

async function insertPaymentIfNeeded(
  client: SqlClient,
  orgId: string,
  storeId: string,
  orderId: string,
  orderBusinessDate: string,
  collectCents: number,
  nowEpoch: number,
  options: PickupApplyOptions | undefined,
  newId: () => string,
): Promise<void> {
  if (collectCents <= 0) return;
  if (options?.staffId === undefined || options.staffId.length === 0) {
    throw new Error("staffId is required when collectCents > 0");
  }
  const payment = buildPayPayment({
    payment_id: options.paymentId ?? newId(),
    org_id: orgId,
    store_id: storeId,
    order_id: orderId,
    amount_cents: collectCents,
    staff_id: options.staffId,
    at: nowEpoch,
    method: options.method ?? "cash",
  });
  await insertLedgerPayment(client, payment, options?.businessDate ?? orderBusinessDate);
}

export async function insertInitialPayment(
  client: SqlClient,
  input: InitialPayment | undefined,
): Promise<void> {
  if (input === undefined) return;
  await insertLedgerPayment(client, input.payment, input.business_date);
}

export async function insertLedgerPayment(
  client: SqlClient,
  payment: LedgerPaymentRow,
  businessDate: string,
): Promise<void> {
  await client.query(
    `INSERT INTO payments (
       id, org_id, store_id, order_id, method, amount_cents, kind,
       ref_payment_id, staff_id, at, business_date, note
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7,
       $8::uuid, $9::uuid, $10, $11, $12
     )`,
    [
      payment.payment_id,
      payment.org_id,
      payment.store_id,
      payment.order_id,
      payment.method,
      payment.amount_cents,
      payment.kind,
      payment.ref_payment_id,
      payment.staff_id,
      epochToDate(payment.at),
      businessDate,
      payment.note,
    ],
  );
}

export async function replaceDraftTxn(
  client: SqlClient,
  order: OrderRecord,
  garments: readonly import("./types.js").GarmentRecord[],
  initialPayment: InitialPayment | undefined,
  newId: () => string,
  requireExisting = false,
): Promise<boolean> {
  const existing = await loadOrder(client, order.org_id, order.store_id, order.order_id, true);
  if (existing === null) {
    if (requireExisting) return false;
    await insertOrderRows(client, order, garments, buildLineIdByIndex(order.lines, newId));
    await insertInitialPayment(client, initialPayment);
    return true;
  }
  if (existing.status !== "draft") return false;

  await client.query(
    `DELETE FROM order_lines
     WHERE org_id = $1::uuid AND store_id = $2::uuid AND order_id = $3::uuid`,
    [order.org_id, order.store_id, order.order_id],
  );
  await client.query(
    `UPDATE orders
     SET ticket_no = $4, pickup_code = $5, status = $6, customer_id = $7,
         customer_phone = $8, customer_name = $9, note = $10,
         subtotal_cents = $11, original_cents = $12, discount_cents = $13, addon_cents = $14,
         urgent_cents = $15, freight_cents = $16, payable_cents = $17, paid_cents = $18,
         balance_cents = $19, business_date = $20,
         pricing_policy_version = $21, urgent_selected = $22, freight_selected = $23,
         customer_profile_version = $24, discount_source = $25, discount_bps = $26,
         membership_version = $27, tier_id = $28::uuid, tier_definition_version = $29,
         tier_code = $30, tier_name = $31, tier_level = $32, tier_discount_bps = $33,
         skip_ticket_print = $34, skip_label_print = $35, skip_rack_assignment = $36,
         created_at = $37, updated_at = $38
     WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
    [
      order.org_id,
      order.store_id,
      order.order_id,
      order.ticket_no,
      order.pickup_code,
      order.status,
      order.customer_id,
      order.customer_phone,
      order.customer_name,
      order.note,
      order.subtotal_cents,
      order.original_cents,
      order.discount_cents,
      order.addon_cents,
      order.urgent_cents,
      order.freight_cents,
      order.payable_cents,
      order.paid_cents,
      order.balance_cents,
      order.business_date,
      order.pricing_policy_version ?? 0,
      order.urgent_selected ?? false,
      order.freight_selected ?? false,
      order.customer_profile_version ?? 0,
      order.discount_source ?? (order.discount_cents > 0 ? "manual" : "none"),
      order.discount_bps ?? 0,
      order.membership_version ?? null,
      order.tier_id ?? null,
      order.tier_definition_version ?? null,
      order.tier_code ?? null,
      order.tier_name ?? null,
      order.tier_level ?? null,
      order.tier_discount_bps ?? null,
      order.skip_ticket_print ?? false,
      order.skip_label_print ?? false,
      order.skip_rack_assignment ?? false,
      epochToDate(order.created_at),
      epochToDate(order.updated_at),
    ],
  );
  await insertOrderChildren(client, order, garments, buildLineIdByIndex(order.lines, newId));
  await insertInitialPayment(client, initialPayment);
  return true;
}

export async function applyPickupTxn(
  client: SqlClient,
  orgId: string,
  storeId: string,
  orderId: string,
  garmentIds: readonly string[],
  collectCents: number,
  nowEpoch: number,
  options: PickupApplyOptions | undefined,
  newId: () => string,
): Promise<PickupApplyResult | null> {
  const order = await loadOrder(client, orgId, storeId, orderId, true);
  if (order === null || order.status !== "open") return null;
  const garments = await loadGarments(client, orgId, storeId, orderId, true);
  if (garments.length === 0 && garmentIds.length > 0) return null;
  const idSet = new Set(garmentIds);
  if (idSet.size !== garmentIds.length) return null;
  if (garments.filter((garment) => idSet.has(garment.garment_id)).length !== idSet.size)
    return null;
  if (
    garments.some(
      (garment) =>
        idSet.has(garment.garment_id) &&
        (!isGarmentAvailableAtStore(garment) ||
          (garment.status !== "received" &&
            garment.status !== "racked" &&
            garment.status !== "ready")),
    )
  ) {
    return null;
  }
  requireVerifiedRackBarcodes(garments, garmentIds, options?.verificationBarcodes ?? []);
  const nextGarments = garments.map((garment) =>
    idSet.has(garment.garment_id)
      ? Object.freeze({ ...garment, status: "picked_up" as const })
      : garment,
  );
  const paid = order.paid_cents + collectCents;
  const balance = order.payable_cents - paid;
  const status = nextOrderStatus(nextGarments, balance);
  assertPickupPlanMatchesCurrentRows(options, balance, status);
  if (garmentIds.length > 0) {
    await markGarmentsPickedUp(client, {
      orgId,
      storeId,
      orderId,
      garmentIds,
      garments,
      staffId: options?.staffId,
      nowEpoch,
      newId,
    });
  }
  await client.query(
    `UPDATE orders
     SET paid_cents = $4, balance_cents = $5, status = $6, updated_at = $7
     WHERE org_id = $1::uuid AND store_id = $2::uuid AND id = $3::uuid`,
    [orgId, storeId, orderId, paid, balance, status, epochToDate(nowEpoch)],
  );
  await insertPaymentIfNeeded(
    client,
    orgId,
    storeId,
    orderId,
    order.business_date,
    collectCents,
    nowEpoch,
    options,
    newId,
  );
  return Object.freeze({
    order: Object.freeze({
      ...order,
      paid_cents: paid,
      balance_cents: balance,
      status,
      updated_at: nowEpoch,
    }),
    garments: Object.freeze(nextGarments),
  });
}

export async function appendPaymentTxn(
  client: SqlClient,
  input: PaymentAppendInput,
  newId: () => string,
): Promise<PaymentAppendResult | null> {
  const order = await loadOrder(client, input.org_id, input.store_id, input.order_id, true);
  if (order === null || order.status !== "open") return null;
  const payments = await listPaymentRows(client, input.org_id, input.store_id, input.order_id);
  const paymentInput = {
    payment_id: newId(),
    org_id: input.org_id,
    store_id: input.store_id,
    order_id: input.order_id,
    amount_cents: input.amount_cents,
    staff_id: input.staff_id,
    at: input.at,
    method: input.method,
    note: input.note,
    payable_cents: order.payable_cents,
    existing_payments: payments,
  } as const;
  const plan =
    input.kind === "pay" ? planCollectPayment(paymentInput) : planRepayPayment(paymentInput);
  if (!plan.ok) return null;
  await insertLedgerPayment(client, plan.payment, input.business_date);
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
    payment: plan.payment,
  });
}

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
  beforeCommit?: () => Promise<void>,
): Promise<OrderRecord | null> {
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
  await beforeCommit?.();
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
