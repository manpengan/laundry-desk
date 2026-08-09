import { asRecord, requireThat, requireUuid } from "./adr36-web-core.mjs";
import { readOrder, requireArray } from "./adr36-web-order-finance-evidence.mjs";

async function resolveOrderId(api, session, orderId, locator) {
  if (orderId !== null && orderId !== undefined) {
    return requireUuid(orderId, "CLEANUP_ORDER_INVALID");
  }
  if (locator === null || locator === undefined) return null;
  const found = asRecord(
    await api.query(session, "order.list", {
      customer_phone: locator.customerPhone,
      limit: 50,
    }),
    "CLEANUP_ORDER_INVALID",
  );
  const matches = requireArray(found.orders, "CLEANUP_ORDER_INVALID").filter((value) => {
    const row = asRecord(value, "CLEANUP_ORDER_INVALID");
    return row.customer_name === locator.customerName && row.payable_cents === locator.payableCents;
  });
  requireThat(matches.length <= 1, "CLEANUP_ORDER_AMBIGUOUS");
  return matches.length === 0
    ? null
    : requireUuid(asRecord(matches[0]).order_id, "CLEANUP_ORDER_INVALID");
}

async function makeGarmentsPickable(api, session, order, note) {
  for (const garment of order.garments) {
    if (garment.status === "washing" || garment.status === "reworked") {
      await api.command(session, "garment.transition", {
        garment_id: garment.garment_id,
        target_status: "ready",
        note,
      });
    }
  }
}

async function pickupSelectable(api, session, order) {
  const selectable = order.garments.filter((garment) =>
    ["received", "ready", "racked"].includes(garment.status),
  );
  if (selectable.length === 0) return;
  await api.command(session, "order.pickup", {
    order_id: order.order_id,
    garment_ids: selectable.map((garment) => garment.garment_id),
    verification_barcodes: selectable
      .filter((garment) => garment.status === "racked")
      .map((garment) => garment.barcode),
    collect_cents: order.balance_cents,
  });
}

async function settleOrder(api, session, orderId, note) {
  if (orderId === null) return;
  let order = await readOrder(api, session, orderId);
  if (order.status === "closed") {
    requireThat(order.balance_cents === 0, "CLEANUP_ORDER_INCOMPLETE");
    return;
  }
  requireThat(order.status === "open", "CLEANUP_ORDER_INCOMPLETE");
  await makeGarmentsPickable(api, session, order, note);
  order = await readOrder(api, session, orderId);
  await pickupSelectable(api, session, order);
  order = await readOrder(api, session, orderId);
  if (order.status === "open" && order.balance_cents > 0) {
    await api.command(session, "payment.repay", {
      order_id: orderId,
      amount_cents: order.balance_cents,
      method: "cash",
      note,
    });
  }
  order = await readOrder(api, session, orderId);
  requireThat(order.status === "closed" && order.balance_cents === 0, "CLEANUP_ORDER_INCOMPLETE");
}

/**
 * Settle only server-observed outstanding state. It never retries refund or a
 * prior repayment blindly; every compensating repayment is sized from a fresh
 * order.get readback.
 */
export async function cleanupOrderFinanceArtifacts(api, artifacts, run, update = () => {}) {
  if (artifacts.adminSession === null || artifacts.adminSession === undefined) {
    return !artifacts.orderFinanceCleanupUncertain;
  }
  let complete = true;
  const attempt = async (operation) => {
    try {
      await operation();
    } catch {
      complete = false;
    }
  };
  for (const kind of ["old", "new"]) {
    await attempt(async () => {
      const orderId = await resolveOrderId(
        api,
        artifacts.adminSession,
        artifacts[`${kind}OrderId`],
        artifacts[`${kind}OrderLocator`],
      );
      await settleOrder(api, artifacts.adminSession, orderId, run.note);
    });
  }
  if (complete) update({ orderFinanceCleanupUncertain: false });
  return complete;
}

export function initialOrderFinanceArtifacts() {
  return Object.freeze({
    orderFinanceCleanupUncertain: false,
    oldOrderId: null,
    oldOrderLocator: null,
    newOrderId: null,
    newOrderLocator: null,
    newOrderRepaymentId: null,
    refundPaymentId: null,
    newOrderRecoveryPaymentId: null,
  });
}
