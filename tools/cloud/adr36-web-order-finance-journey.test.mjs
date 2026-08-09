import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanupOrderFinanceArtifacts,
  initialOrderFinanceArtifacts,
  orderFinanceJourney,
} from "./adr36-web-order-finance-journey.mjs";

const DAY = "2026-08-09";
const ADMIN_ID = "11111111-1111-4111-8111-111111111101";
const APPROVER_ID = "11111111-1111-4111-8111-111111111102";
const OLD_PRICE = 2_600;
const NEW_PRICE = 3_300;
const REFUND_CENTS = 400;

function uuid(sequence) {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function runFixture() {
  return Object.freeze({
    runId: "ADR36-20260809T123456Z-12345678",
    label: "ADR36 UAT 20260809T123456Z 12345678",
    note: "ADR36-UAT-20260809T123456Z-12345678",
    catalogCode: "uat_20260809_12345678",
    serviceCode: "uat_s_12345678",
    categoryCode: "uat_c_12345678",
    rackSlot: "12345678",
  });
}

function artifactFixture() {
  return Object.freeze({
    ...initialOrderFinanceArtifacts(),
    cleanupUncertain: false,
    adminSession: Object.freeze({ staffId: ADMIN_ID }),
    approverSession: Object.freeze({ staffId: APPROVER_ID }),
    customerPhone: "13800000123",
    catalogItem: Object.freeze({
      code: "uat_20260809_12345678",
      name: "ADR36 UAT catalog",
      service_code: "uat_s_12345678",
      category_code: "uat_c_12345678",
      unit_price_cents: OLD_PRICE,
      is_active: true,
      sort_order: 9_999,
    }),
  });
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function createFakeApi(initialCatalog, options = {}) {
  let catalog = Object.freeze({ ...initialCatalog });
  let orders = Object.freeze([]);
  let payments = Object.freeze([]);
  let sequence = 100;
  let wrongBarcodeFailures = 0;
  let refundStepUps = 0;
  let refundReplays = 0;

  const nextUuid = () => uuid(++sequence);
  const findOrder = (orderId) => orders.find((order) => order.order_id === orderId);
  const requireOrder = (orderId) => {
    const order = findOrder(orderId);
    assert.ok(order, `missing fake order ${orderId}`);
    return order;
  };
  const replaceOrder = (next) => {
    orders = Object.freeze(
      orders.map((order) => (order.order_id === next.order_id ? Object.freeze(next) : order)),
    );
  };
  const appendPayment = (row) => {
    payments = Object.freeze([...payments, Object.freeze(row)]);
  };

  const orderResult = (order) => ({
    order_id: order.order_id,
    ticket_no: order.ticket_no,
    status: order.status,
    customer_phone: order.customer_phone,
    customer_name: order.customer_name,
    payable_cents: order.payable_cents,
    paid_cents: order.paid_cents,
    balance_cents: order.balance_cents,
    garments: order.garments.map((garment) => ({ ...garment })),
  });

  const updateGarment = (garmentId, transform) => {
    const owner = orders.find((order) =>
      order.garments.some((garment) => garment.garment_id === garmentId),
    );
    assert.ok(owner, `missing fake garment ${garmentId}`);
    replaceOrder({
      ...owner,
      garments: Object.freeze(
        owner.garments.map((garment) =>
          garment.garment_id === garmentId ? Object.freeze(transform(garment)) : garment,
        ),
      ),
    });
  };

  const receive = (args) => {
    const orderId = nextUuid();
    const garmentId = nextUuid();
    const price = catalog.unit_price_cents;
    const paid = args.initial_payment?.amount_cents ?? 0;
    const order = Object.freeze({
      order_id: orderId,
      ticket_no: `20260809-${String(orders.length + 1).padStart(4, "0")}`,
      status: "open",
      customer_phone: args.customer_phone,
      customer_name: args.customer_name,
      payable_cents: price,
      paid_cents: paid,
      balance_cents: price - paid,
      garments: Object.freeze([
        Object.freeze({
          garment_id: garmentId,
          barcode: `UATBARCODE${orders.length + 1}`,
          status: "received",
          unit_price_cents: price,
          rack_zone: null,
          rack_slot: null,
        }),
      ]),
    });
    orders = Object.freeze([...orders, order]);
    if (paid > 0) {
      appendPayment({
        payment_id: nextUuid(),
        order_id: orderId,
        kind: "pay",
        amount_cents: paid,
        method: args.initial_payment.method,
      });
    }
    return Object.freeze({ ...orderResult(order), garment_count: 1 });
  };

  const transition = (args) => {
    updateGarment(args.garment_id, (garment) => ({
      ...garment,
      status: args.target_status,
      ...(args.target_status === "ready" ? { rack_zone: null, rack_slot: null } : {}),
    }));
    return Object.freeze({ transitioned_count: 1 });
  };

  const rack = (args) => {
    const owner = orders.find((order) =>
      order.garments.some((garment) => garment.barcode === args.barcode),
    );
    assert.ok(owner);
    const garment = owner.garments.find((row) => row.barcode === args.barcode);
    updateGarment(garment.garment_id, (row) => ({
      ...row,
      status: "racked",
      rack_zone: args.rack_zone,
      rack_slot: args.rack_slot,
    }));
    return Object.freeze({ status: "racked" });
  };

  const pickup = (args) => {
    const order = requireOrder(args.order_id);
    const selected =
      args.garment_ids.length === 0
        ? order.garments
        : order.garments.filter((garment) => args.garment_ids.includes(garment.garment_id));
    const nextGarments = order.garments.map((garment) =>
      selected.some((row) => row.garment_id === garment.garment_id)
        ? Object.freeze({ ...garment, status: "picked_up", rack_zone: null, rack_slot: null })
        : garment,
    );
    const nextBalance = order.balance_cents - args.collect_cents;
    const nextPaid = order.paid_cents + args.collect_cents;
    if (args.collect_cents > 0) {
      appendPayment({
        payment_id: nextUuid(),
        order_id: order.order_id,
        kind: "pay",
        amount_cents: args.collect_cents,
        method: "cash",
      });
    }
    const status =
      nextBalance === 0 && nextGarments.every((garment) => garment.status === "picked_up")
        ? "closed"
        : "open";
    replaceOrder({
      ...order,
      status,
      paid_cents: nextPaid,
      balance_cents: nextBalance,
      garments: Object.freeze(nextGarments),
    });
    return Object.freeze({
      order_id: order.order_id,
      status,
      paid_cents: nextPaid,
      balance_cents: nextBalance,
    });
  };

  const repay = (args) => {
    const order = requireOrder(args.order_id);
    assert.equal(order.status, "open");
    assert.ok(args.amount_cents > 0 && args.amount_cents <= order.balance_cents);
    const paymentId = nextUuid();
    appendPayment({
      payment_id: paymentId,
      order_id: order.order_id,
      kind: "repay",
      amount_cents: args.amount_cents,
      method: args.method,
    });
    const paid = order.paid_cents + args.amount_cents;
    const balance = order.balance_cents - args.amount_cents;
    const status =
      balance === 0 && order.garments.every((garment) => garment.status === "picked_up")
        ? "closed"
        : "open";
    replaceOrder({ ...order, status, paid_cents: paid, balance_cents: balance });
    return Object.freeze({
      order_id: order.order_id,
      payment_id: paymentId,
      kind: "repay",
      paid_cents: paid,
      balance_cents: balance,
      status,
    });
  };

  const refund = (args) => {
    const order = requireOrder(args.order_id);
    const reference = payments.find((payment) => payment.payment_id === args.ref_payment_id);
    assert.ok(reference);
    assert.equal(reference.method, args.method);
    const paymentId = nextUuid();
    appendPayment({
      payment_id: paymentId,
      order_id: order.order_id,
      kind: "refund",
      amount_cents: args.amount_cents,
      method: args.method,
      ref_payment_id: args.ref_payment_id,
    });
    const paid = order.paid_cents - args.amount_cents;
    const balance = order.balance_cents + args.amount_cents;
    replaceOrder({ ...order, status: "open", paid_cents: paid, balance_cents: balance });
    return Object.freeze({
      order_id: order.order_id,
      payment_id: paymentId,
      kind: "refund",
      ref_payment_id: args.ref_payment_id,
      paid_cents: paid,
      balance_cents: balance,
      status: "open",
    });
  };

  const stats = () => {
    const included = orders.filter((order) => order.status === "open" || order.status === "closed");
    return Object.freeze({
      business_date: DAY,
      order_count: included.length,
      garment_count: sum(included.map((order) => order.garments.length)),
      payable_cents: sum(included.map((order) => order.payable_cents)),
      paid_cents: sum(included.map((order) => order.paid_cents)),
      balance_cents: sum(included.map((order) => order.balance_cents)),
      payment_cents: sum(
        payments.filter((payment) => payment.kind === "pay").map((payment) => payment.amount_cents),
      ),
      picked_garment_count: sum(
        included.map(
          (order) => order.garments.filter((garment) => garment.status === "picked_up").length,
        ),
      ),
    });
  };

  const accounting = () => {
    const net = sum(
      payments.map((payment) =>
        payment.kind === "refund" ? -payment.amount_cents : payment.amount_cents,
      ),
    );
    return Object.freeze({
      date_from: DAY,
      date_to: DAY,
      group_by: "day",
      totals: Object.freeze({
        real_income_cents: net,
        performance_income_cents: net,
        order_cashflow_cents: net,
        stored_value_cashflow_cents: 0,
        stored_value_consumption_cents: 0,
        ledger_row_count: payments.length,
      }),
      rows: Object.freeze([]),
    });
  };

  const query = async (_session, name, args) => {
    if (name === "stats.day.summary") return stats();
    if (name === "accounting.report.get") return accounting();
    if (name === "catalog.items.get") {
      return Object.freeze({ item: args.code === catalog.code ? catalog : null });
    }
    if (name === "order.get") return Object.freeze(orderResult(requireOrder(args.order_id)));
    if (name === "order.list") {
      return Object.freeze({
        orders: Object.freeze(
          orders
            .filter((order) => order.customer_phone === args.customer_phone)
            .map((order) => Object.freeze(orderResult(order))),
        ),
      });
    }
    if (name === "order.lookup") {
      const matches = orders.filter(
        (order) =>
          order.status === args.status &&
          order.garments.some((garment) => garment.barcode === args.key),
      );
      return Object.freeze({
        orders: Object.freeze(
          matches.map((order) =>
            Object.freeze({ ...orderResult(order), matched_by: "garment_barcode" }),
          ),
        ),
      });
    }
    if (name === "fulfillment.workbench") {
      const garments = orders.flatMap((order) =>
        order.garments
          .filter(
            (garment) => args.statuses.includes(garment.status) && garment.barcode === args.key,
          )
          .map((garment) => Object.freeze({ ...garment, order_id: order.order_id })),
      );
      return Object.freeze({ garments: Object.freeze(garments) });
    }
    assert.fail(`unexpected query ${name}`);
  };

  const command = async (_session, name, args) => {
    if (name === "catalog.item.upsert") {
      assert.equal(args.code, catalog.code);
      catalog = Object.freeze({ ...args });
      return Object.freeze({ code: args.code, created: false });
    }
    if (name === "order.receive") return receive(args);
    if (name === "garment.transition") return transition(args);
    if (name === "garment.rack.assign") return rack(args);
    if (name === "order.pickup") return pickup(args);
    if (name === "payment.repay") return repay(args);
    assert.fail(`unexpected command ${name}`);
  };

  const expectCommandFailure = async (_session, name, args, expectedCode) => {
    assert.equal(name, "order.pickup");
    assert.equal(expectedCode, "VALIDATION_FAILED");
    const orderBefore = requireOrder(args.order_id);
    const garment = orderBefore.garments.find((row) => args.garment_ids.includes(row.garment_id));
    assert.ok(garment);
    assert.equal(args.verification_barcodes.includes(garment.barcode), false);
    wrongBarcodeFailures += 1;
  };

  const stepUpReplayable = async (session, name, args, approverStaffId, pin) => {
    assert.equal(session.staffId, ADMIN_ID);
    assert.equal(name, "payment.refund");
    assert.equal(approverStaffId, APPROVER_ID);
    assert.equal(pin, "850274");
    refundStepUps += 1;
    const result = refund(args);
    if (options.throwAfterRefund === true) throw new Error("simulated lost refund response");
    return Object.freeze({
      result,
      replay: async () => {
        refundReplays += 1;
        return result;
      },
    });
  };

  return Object.freeze({
    api: Object.freeze({
      command,
      query,
      expectCommandFailure,
      stepUpReplayable,
    }),
    state: () =>
      Object.freeze({
        catalog,
        orders,
        payments,
        wrongBarcodeFailures,
        refundStepUps,
        refundReplays,
      }),
  });
}

function credentialsFixture() {
  return Object.freeze({ approver: Object.freeze({ pin: "850274" }) });
}

function updater(initial) {
  let artifacts = initial;
  return Object.freeze({
    get: () => artifacts,
    update: (patch) => {
      artifacts = Object.freeze({ ...artifacts, ...patch });
    },
  });
}

test("order finance journey proves pricing, debt, R4 replay, and exact deltas", async () => {
  const initial = artifactFixture();
  const fake = createFakeApi(initial.catalogItem);
  const state = updater(initial);
  const report = await orderFinanceJourney(
    fake.api,
    credentialsFixture(),
    state.get(),
    runFixture(),
    state.update,
  );

  assert.equal(report.businessDate, DAY);
  assert.notEqual(report.oldOrderId, report.newOrderId);
  assert.notEqual(report.repaymentPaymentId, report.recoveryPaymentId);
  const current = fake.state();
  assert.equal(current.catalog.unit_price_cents, NEW_PRICE);
  assert.equal(current.wrongBarcodeFailures, 1);
  assert.equal(current.refundStepUps, 1);
  assert.equal(current.refundReplays, 1);
  assert.deepEqual(
    current.orders.map((order) => [order.status, order.balance_cents]),
    [
      ["closed", 0],
      ["closed", 0],
    ],
  );
  assert.deepEqual(
    current.payments.map((payment) => payment.kind),
    ["pay", "repay", "refund", "repay"],
  );
  assert.equal(current.payments.filter((payment) => payment.kind === "refund").length, 1);
  assert.equal(state.get().orderFinanceCleanupUncertain, false);
});

test("cleanup settles the observed refund balance after a lost response without retrying refund", async () => {
  const initial = artifactFixture();
  const fake = createFakeApi(initial.catalogItem, { throwAfterRefund: true });
  const state = updater(initial);
  await assert.rejects(() =>
    orderFinanceJourney(fake.api, credentialsFixture(), state.get(), runFixture(), state.update),
  );
  const before = fake.state();
  const newOrder = before.orders.find((order) => order.order_id === state.get().newOrderId);
  assert.equal(newOrder.status, "open");
  assert.equal(newOrder.balance_cents, REFUND_CENTS);
  assert.equal(state.get().orderFinanceCleanupUncertain, true);

  assert.equal(
    await cleanupOrderFinanceArtifacts(fake.api, state.get(), runFixture(), state.update),
    true,
  );
  const after = fake.state();
  const settled = after.orders.find((order) => order.order_id === state.get().newOrderId);
  assert.equal(settled.status, "closed");
  assert.equal(settled.balance_cents, 0);
  assert.equal(after.refundStepUps, 1);
  assert.equal(after.refundReplays, 0);
  assert.equal(after.payments.filter((payment) => payment.kind === "refund").length, 1);
  assert.deepEqual(
    after.payments.map((payment) => payment.kind),
    ["pay", "repay", "refund", "repay"],
  );
  assert.equal(state.get().orderFinanceCleanupUncertain, false);
});

test("order finance cleanup never clears uncertainty owned by another journey", async () => {
  const initial = Object.freeze({ ...artifactFixture(), cleanupUncertain: true });
  const fake = createFakeApi(initial.catalogItem);
  const state = updater(initial);

  assert.equal(
    await cleanupOrderFinanceArtifacts(fake.api, state.get(), runFixture(), state.update),
    true,
  );
  assert.equal(state.get().orderFinanceCleanupUncertain, false);
  assert.equal(state.get().cleanupUncertain, true);
});
