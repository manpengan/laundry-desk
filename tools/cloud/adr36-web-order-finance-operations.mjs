import { asRecord, requireThat, requireUuid } from "./adr36-web-core.mjs";
import {
  REFUND_CENTS,
  assertEvidenceDelta,
  assertOrderSnapshot,
  readEvidence,
  readOrder,
  requireArray,
  zeroBasis,
  zeroStats,
} from "./adr36-web-order-finance-evidence.mjs";

async function mutation(update, locator, operation, register = (value) => value) {
  update({ ...locator, orderFinanceCleanupUncertain: true });
  const value = await operation();
  const registered = register(value);
  update({ orderFinanceCleanupUncertain: false });
  return registered;
}

// Keep catalog-price finance evidence independent from the member policy journey.
function orderInput(run, customerName, note, initialPayment) {
  return Object.freeze({
    customer_name: customerName,
    lines: [
      Object.freeze({
        service_code: run.serviceCode,
        category_code: run.categoryCode,
        qty: 1,
        color: "UAT",
      }),
    ],
    ...(initialPayment === undefined ? {} : { initial_payment: initialPayment }),
    note,
  });
}

export async function createOrder(api, artifacts, run, update, kind, priceCents, paid) {
  const customerName = `${run.label} ${kind === "old" ? "OLD" : "NEW"}`;
  const note = `${run.note}-${kind.toUpperCase()}`;
  const locatorName = `${kind}OrderLocator`;
  const idName = `${kind}OrderId`;
  const locator = Object.freeze({
    customerPhone: null,
    customerName,
    note,
    payableCents: priceCents,
  });
  const initialPayment = paid
    ? Object.freeze({ amount_cents: priceCents, method: "cash", note })
    : undefined;
  const result = asRecord(
    await mutation(
      update,
      { [locatorName]: locator },
      () =>
        api.command(
          artifacts.adminSession,
          "order.receive",
          orderInput(run, customerName, note, initialPayment),
        ),
      (value) => {
        const record = asRecord(value, "ORDER_RECEIVE_INVALID");
        update({ [idName]: requireUuid(record.order_id, "ORDER_RECEIVE_INVALID") });
        return record;
      },
    ),
    "ORDER_RECEIVE_INVALID",
  );
  requireThat(
    result.payable_cents === priceCents &&
      result.paid_cents === (paid ? priceCents : 0) &&
      result.balance_cents === (paid ? 0 : priceCents),
    "ORDER_RECEIVE_INVALID",
  );
  return readOrder(api, artifacts.adminSession, result.order_id);
}

export async function fulfillAndRack(api, session, run, update, order, suffix) {
  requireThat(order.garments.length === 1, "ORDER_READBACK_INVALID");
  const garment = order.garments[0];
  for (const targetStatus of ["washing", "ready"]) {
    await mutation(update, {}, () =>
      api.command(session, "garment.transition", {
        garment_id: garment.garment_id,
        target_status: targetStatus,
        note: run.note,
      }),
    );
  }
  await mutation(update, {}, () =>
    api.command(session, "garment.rack.assign", {
      barcode: garment.barcode,
      rack_zone: "UAT",
      rack_slot: `${run.rackSlot.slice(0, 14)}${suffix}`,
    }),
  );
  return readOrder(api, session, order.order_id);
}

export async function assertLocated(api, session, order) {
  const garment = order.garments[0];
  const lookup = asRecord(
    await api.query(session, "order.lookup", { key: garment.barcode, status: "open", limit: 10 }),
    "ORDER_LOOKUP_INVALID",
  );
  const matches = requireArray(lookup.orders, "ORDER_LOOKUP_INVALID").filter((value) => {
    const row = asRecord(value, "ORDER_LOOKUP_INVALID");
    return row.order_id === order.order_id && row.matched_by === "garment_barcode";
  });
  requireThat(matches.length === 1, "ORDER_LOOKUP_INVALID");
  const workbench = asRecord(
    await api.query(session, "fulfillment.workbench", {
      statuses: ["racked"],
      key: garment.barcode,
      limit: 10,
    }),
    "FULFILLMENT_QUERY_INVALID",
  );
  const located = requireArray(workbench.garments, "FULFILLMENT_QUERY_INVALID").filter(
    (value) => asRecord(value, "FULFILLMENT_QUERY_INVALID").garment_id === garment.garment_id,
  );
  requireThat(located.length === 1, "FULFILLMENT_QUERY_INVALID");
}

export async function rejectWrongBarcode(api, session, run, update, order, businessDate) {
  const evidenceBefore = await readEvidence(api, session, businessDate);
  const garment = order.garments[0];
  const wrongBarcode = `WRONG-${run.rackSlot}`;
  requireThat(wrongBarcode.toUpperCase() !== garment.barcode.toUpperCase(), "BARCODE_COLLISION");
  update({ orderFinanceCleanupUncertain: true });
  await api.expectCommandFailure(
    session,
    "order.pickup",
    {
      order_id: order.order_id,
      garment_ids: [garment.garment_id],
      verification_barcodes: [wrongBarcode],
      collect_cents: 0,
    },
    "VALIDATION_FAILED",
  );
  const after = await readOrder(api, session, order.order_id);
  assertOrderSnapshot(after, order, "WRONG_BARCODE_MUTATED_ORDER");
  const evidenceAfter = await readEvidence(api, session, businessDate);
  assertEvidenceDelta(
    evidenceBefore,
    evidenceAfter,
    zeroStats(),
    zeroBasis(),
    "WRONG_BARCODE_MUTATED_FINANCE",
  );
  update({ orderFinanceCleanupUncertain: false });
}

export async function repriceCatalog(api, artifacts, update, newPriceCents) {
  const item = Object.freeze({ ...artifacts.catalogItem, unit_price_cents: newPriceCents });
  const result = asRecord(
    await mutation(update, { catalogItem: item }, () =>
      api.command(artifacts.adminSession, "catalog.item.upsert", item),
    ),
    "CATALOG_UPSERT_INVALID",
  );
  requireThat(result.code === item.code && result.created === false, "CATALOG_UPSERT_INVALID");
  const view = asRecord(
    await api.query(artifacts.adminSession, "catalog.items.get", { code: item.code }),
    "CATALOG_READBACK_INVALID",
  );
  const readback = asRecord(view.item, "CATALOG_READBACK_INVALID");
  requireThat(readback.unit_price_cents === newPriceCents, "CATALOG_READBACK_INVALID");
}

export async function pickup(api, session, update, order) {
  const garment = order.garments[0];
  await mutation(update, {}, () =>
    api.command(session, "order.pickup", {
      order_id: order.order_id,
      garment_ids: [garment.garment_id],
      verification_barcodes: [garment.barcode],
      collect_cents: 0,
    }),
  );
  return readOrder(api, session, order.order_id);
}

export async function repay(api, session, update, orderId, amountCents, note, artifactName) {
  const result = asRecord(
    await mutation(update, {}, () =>
      api.command(session, "payment.repay", {
        order_id: orderId,
        amount_cents: amountCents,
        method: "cash",
        note,
      }),
    ),
    "PAYMENT_REPAY_INVALID",
  );
  const paymentId = requireUuid(result.payment_id, "PAYMENT_REPAY_INVALID");
  update({ [artifactName]: paymentId });
  return result;
}

export async function refundWithReplay(api, credentials, artifacts, run, update, repaymentId) {
  requireThat(
    artifacts.adminSession.staffId !== artifacts.approverSession.staffId,
    "ADMIN_IDENTITIES_NOT_DISTINCT",
  );
  update({ orderFinanceCleanupUncertain: true });
  const replayable = await api.stepUpReplayable(
    artifacts.adminSession,
    "payment.refund",
    {
      order_id: artifacts.newOrderId,
      amount_cents: REFUND_CENTS,
      method: "cash",
      ref_payment_id: repaymentId,
      reason: run.note,
    },
    artifacts.approverSession.staffId,
    credentials.approver.pin,
  );
  const first = asRecord(replayable.result, "PAYMENT_REFUND_INVALID");
  update({ refundPaymentId: requireUuid(first.payment_id, "PAYMENT_REFUND_INVALID") });
  requireThat(typeof replayable.replay === "function", "PAYMENT_REFUND_REPLAY_INVALID");
  return Object.freeze({ first, replay: replayable.replay });
}

export function assertRefundReplay(first, replay) {
  for (const field of [
    "order_id",
    "payment_id",
    "kind",
    "ref_payment_id",
    "paid_cents",
    "balance_cents",
    "status",
  ]) {
    requireThat(first[field] === replay[field], "PAYMENT_REFUND_REPLAY_INVALID");
  }
}
