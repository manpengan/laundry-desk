import { asRecord, requireThat, requireUuid } from "./adr36-web-core.mjs";
import {
  cleanupOrderFinanceArtifacts,
  initialOrderFinanceArtifacts,
} from "./adr36-web-order-finance-cleanup.mjs";
import {
  PRICE_INCREMENT_CENTS,
  REFUND_CENTS,
  assertEvidenceDelta,
  assertOrderMoney,
  assertOrderSnapshot,
  paymentBasis,
  readEvidence,
  readOrder,
  requirePositiveInteger,
  statsDelta,
  zeroBasis,
  zeroStats,
} from "./adr36-web-order-finance-evidence.mjs";
import {
  assertLocated,
  assertRefundReplay,
  createOrder,
  fulfillAndRack,
  pickup,
  refundWithReplay,
  rejectWrongBarcode,
  repay,
  repriceCatalog,
} from "./adr36-web-order-finance-operations.mjs";

export { cleanupOrderFinanceArtifacts, initialOrderFinanceArtifacts };

/**
 * API surface expected by {@link orderFinanceJourney}.
 *
 * `command` and `query` use the normal acceptance client semantics.
 * `expectCommandFailure(session, name, args, code)` must resolve only when the
 * remote command fails with exactly `code`; it must never retry a possibly
 * committed command with a fresh idempotency key.
 * `stepUpReplayable(session, name, args, approverStaffId, pin)` must initiate
 * the R4 action once, bind a different administrator's proof, execute confirm,
 * and return `{ result, replay }`. Calling the zero-argument `replay` function
 * must resend the exact same confirm_ref and idempotency key, not mint either.
 *
 * @typedef {Readonly<{
 *   command: (session: unknown, name: string, args: object) => Promise<unknown>,
 *   query: (session: unknown, name: string, args: object) => Promise<unknown>,
 *   expectCommandFailure: (
 *     session: unknown,
 *     name: string,
 *     args: object,
 *     expectedCode: string,
 *   ) => Promise<void>,
 *   stepUpReplayable: (
 *     session: unknown,
 *     name: string,
 *     args: object,
 *     approverStaffId: string,
 *     pin: string,
 *   ) => Promise<Readonly<{result: unknown, replay: () => Promise<unknown>}>>,
 * }>} OrderFinanceAcceptanceApi
 */

async function prepareOldOrder(api, artifacts, run, update, baseline, oldPrice, newPrice) {
  let order = await createOrder(api, artifacts, run, update, "old", oldPrice, true);
  order = await fulfillAndRack(api, artifacts.adminSession, run, update, order, "O");
  await assertLocated(api, artifacts.adminSession, order);
  await rejectWrongBarcode(api, artifacts.adminSession, run, update, order, baseline.date);
  await repriceCatalog(api, artifacts, update, newPrice);
  const snapshot = await readOrder(api, artifacts.adminSession, order.order_id);
  requireThat(
    snapshot.payable_cents === oldPrice &&
      snapshot.garments.every((garment) => garment.unit_price_cents === oldPrice),
    "ORDER_PRICE_SNAPSHOT_CHANGED",
  );
  order = await pickup(api, artifacts.adminSession, update, snapshot);
  assertOrderMoney(
    order,
    {
      status: "closed",
      payable_cents: oldPrice,
      paid_cents: oldPrice,
      balance_cents: 0,
    },
    "OLD_ORDER_CLOSE_INVALID",
  );
  return order;
}

async function prepareNewOrder(api, artifacts, run, update, newPrice) {
  const currentArtifacts = Object.freeze({
    ...artifacts,
    catalogItem: Object.freeze({ ...artifacts.catalogItem, unit_price_cents: newPrice }),
  });
  let order = await createOrder(api, currentArtifacts, run, update, "new", newPrice, false);
  order = await fulfillAndRack(api, artifacts.adminSession, run, update, order, "N");
  order = await pickup(api, artifacts.adminSession, update, order);
  assertOrderMoney(
    order,
    {
      status: "open",
      payable_cents: newPrice,
      paid_cents: 0,
      balance_cents: newPrice,
    },
    "DEBT_ORDER_PICKUP_INVALID",
  );
  return order;
}

function assertSetupDelta(baseline, setup, oldPrice, newPrice) {
  assertEvidenceDelta(
    baseline,
    setup,
    statsDelta({
      order_count: 2,
      garment_count: 2,
      payable_cents: oldPrice + newPrice,
      paid_cents: oldPrice,
      balance_cents: newPrice,
      payment_cents: oldPrice,
      picked_garment_count: 2,
    }),
    paymentBasis(oldPrice),
    "ORDER_SETUP_DELTA_INVALID",
  );
}

async function repayDebt(api, artifacts, run, update, order, newPrice, setup, date) {
  const result = await repay(
    api,
    artifacts.adminSession,
    update,
    order.order_id,
    newPrice,
    run.note,
    "newOrderRepaymentId",
  );
  const repaymentId = requireUuid(result.payment_id, "PAYMENT_REPAY_INVALID");
  requireThat(
    result.status === "closed" && result.paid_cents === newPrice && result.balance_cents === 0,
    "PAYMENT_REPAY_INVALID",
  );
  const readback = await readOrder(api, artifacts.adminSession, order.order_id);
  assertOrderMoney(
    readback,
    {
      status: "closed",
      payable_cents: newPrice,
      paid_cents: newPrice,
      balance_cents: 0,
    },
    "PAYMENT_REPAY_INVALID",
  );
  const evidence = await readEvidence(api, artifacts.adminSession, date);
  assertEvidenceDelta(
    setup,
    evidence,
    statsDelta({ paid_cents: newPrice, balance_cents: -newPrice }),
    paymentBasis(newPrice),
    "PAYMENT_REPAY_DELTA_INVALID",
  );
  return Object.freeze({ repaymentId, evidence });
}

function assertRefundResult(refund, orderId, repaymentId, newPrice) {
  requireThat(
    refund.order_id === orderId &&
      refund.kind === "refund" &&
      refund.ref_payment_id === repaymentId &&
      refund.paid_cents === newPrice - REFUND_CENTS &&
      refund.balance_cents === REFUND_CENTS &&
      refund.status === "open",
    "PAYMENT_REFUND_INVALID",
  );
}

async function assertRefundReadback(api, artifacts, orderId, newPrice) {
  const order = await readOrder(api, artifacts.adminSession, orderId);
  assertOrderMoney(
    order,
    {
      status: "open",
      payable_cents: newPrice,
      paid_cents: newPrice - REFUND_CENTS,
      balance_cents: REFUND_CENTS,
    },
    "PAYMENT_REFUND_INVALID",
  );
  return order;
}

async function refundAndReplay(
  api,
  credentials,
  artifacts,
  run,
  update,
  order,
  newPrice,
  repaymentId,
  repaid,
  date,
) {
  const replayable = await refundWithReplay(
    api,
    credentials,
    { ...artifacts, newOrderId: order.order_id },
    run,
    update,
    repaymentId,
  );
  const refund = replayable.first;
  assertRefundResult(refund, order.order_id, repaymentId, newPrice);
  const refundedOrder = await assertRefundReadback(api, artifacts, order.order_id, newPrice);
  const refunded = await readEvidence(api, artifacts.adminSession, date);
  assertEvidenceDelta(
    repaid,
    refunded,
    statsDelta({ paid_cents: -REFUND_CENTS, balance_cents: REFUND_CENTS }),
    paymentBasis(-REFUND_CENTS),
    "PAYMENT_REFUND_DELTA_INVALID",
  );
  const replay = asRecord(await replayable.replay(), "PAYMENT_REFUND_REPLAY_INVALID");
  assertRefundReplay(refund, replay);
  const replayedOrder = await readOrder(api, artifacts.adminSession, order.order_id);
  assertOrderSnapshot(replayedOrder, refundedOrder, "PAYMENT_REFUND_REPLAY_MUTATED");
  const replayed = await readEvidence(api, artifacts.adminSession, date);
  assertEvidenceDelta(
    refunded,
    replayed,
    zeroStats(),
    zeroBasis(),
    "PAYMENT_REFUND_REPLAY_MUTATED",
  );
  update({ orderFinanceCleanupUncertain: false });
  return Object.freeze({ refund, refunded });
}

async function recoverRefund(api, artifacts, run, update, order, newPrice, refunded, date) {
  const recovery = await repay(
    api,
    artifacts.adminSession,
    update,
    order.order_id,
    REFUND_CENTS,
    run.note,
    "newOrderRecoveryPaymentId",
  );
  requireThat(
    recovery.paid_cents === newPrice &&
      recovery.balance_cents === 0 &&
      recovery.status === "closed",
    "PAYMENT_RECOVERY_INVALID",
  );
  const readback = await readOrder(api, artifacts.adminSession, order.order_id);
  assertOrderMoney(
    readback,
    {
      status: "closed",
      payable_cents: newPrice,
      paid_cents: newPrice,
      balance_cents: 0,
    },
    "PAYMENT_RECOVERY_INVALID",
  );
  const recovered = await readEvidence(api, artifacts.adminSession, date);
  assertEvidenceDelta(
    refunded,
    recovered,
    statsDelta({ paid_cents: REFUND_CENTS, balance_cents: -REFUND_CENTS }),
    paymentBasis(REFUND_CENTS),
    "PAYMENT_RECOVERY_DELTA_INVALID",
  );
  return recovery;
}

/** Run the ADR-36 order/pricing/repayment/refund evidence sequence. */
export async function orderFinanceJourney(api, credentials, artifacts, run, update) {
  const oldPrice = requirePositiveInteger(
    asRecord(artifacts.catalogItem, "CATALOG_ITEM_MISSING").unit_price_cents,
    "CATALOG_PRICE_INVALID",
  );
  const newPrice = oldPrice + PRICE_INCREMENT_CENTS;
  requireThat(Number.isSafeInteger(newPrice), "CATALOG_PRICE_INVALID");
  const baseline = await readEvidence(api, artifacts.adminSession);
  const oldOrder = await prepareOldOrder(api, artifacts, run, update, baseline, oldPrice, newPrice);
  const newOrder = await prepareNewOrder(api, artifacts, run, update, newPrice);
  const setup = await readEvidence(api, artifacts.adminSession, baseline.date);
  assertSetupDelta(baseline, setup, oldPrice, newPrice);
  const repaid = await repayDebt(
    api,
    artifacts,
    run,
    update,
    newOrder,
    newPrice,
    setup,
    baseline.date,
  );
  const refunded = await refundAndReplay(
    api,
    credentials,
    artifacts,
    run,
    update,
    newOrder,
    newPrice,
    repaid.repaymentId,
    repaid.evidence,
    baseline.date,
  );
  const recovery = await recoverRefund(
    api,
    artifacts,
    run,
    update,
    newOrder,
    newPrice,
    refunded.refunded,
    baseline.date,
  );
  return Object.freeze({
    businessDate: baseline.date,
    oldOrderId: oldOrder.order_id,
    newOrderId: newOrder.order_id,
    repaymentPaymentId: repaid.repaymentId,
    refundPaymentId: requireUuid(refunded.refund.payment_id, "PAYMENT_REFUND_INVALID"),
    recoveryPaymentId: requireUuid(recovery.payment_id, "PAYMENT_RECOVERY_INVALID"),
  });
}
