import assert from "node:assert/strict";
import test from "node:test";
import { useSyncExternalStore } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { ChannelIntent } from "@laundry/contracts";
import { ToastProvider } from "@laundry/ui";
import { createMockCommandClient } from "../commands/command-client.js";
import { createPaymentChannelPort } from "../host/payment-channel-port.js";
import { ReceivePage } from "./ReceivePage.js";
import { ReceiveWorkspaceProvider, useReceiveWorkspaceAccess } from "./ReceiveWorkspace.js";
import { createReceiveWorkspace } from "./receive-workspace.js";
import { confirmReceivePayment } from "./receive-payment.js";
import type { ReceiveOrderResult } from "./order-form.js";
import type { QueryPort } from "../commands/types.js";
import { ReceiveCompletedWorkspace } from "./ReceiveCompletedWorkspace.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const orderId = "11111111-1111-4111-8111-111111111111";
const opened: ReceiveOrderResult = {
  order_id: orderId,
  ticket_no: "20261006-0010",
  pickup_code: "P10",
  payable_cents: 3000,
  paid_cents: 1000,
  balance_cents: 2000,
  discount_cents: 0,
  discount_source: "none",
  discount_bps: 0,
  waivers: { skip_ticket_print: true, skip_label_print: true, skip_rack_assignment: true },
  garment_count: 0,
  garments: [],
};
const paid: ChannelIntent = {
  intent_id: "22222222-2222-4222-8222-222222222222",
  order_id: orderId,
  purpose: "order",
  channel: "wechat",
  amount_cents: 2000,
  state: "paid",
  qr_url: null,
  payment_id: "33333333-3333-4333-8333-333333333333",
  created_at: "2026-10-06T00:00:00.000Z",
  expires_at: "2026-10-06T01:00:00.000Z",
  error_code: null,
};

test("confirmed payments are idempotent, scoped to the current order and reset for a new order", () => {
  const store = createReceiveWorkspace();
  store.patch({ result: opened, phase: "complete" });
  confirmReceivePayment(store, { ...paid, state: "pending" });
  confirmReceivePayment(store, { ...paid, order_id: paid.payment_id });
  assert.equal(store.getSnapshot().result, opened);
  confirmReceivePayment(store, paid);
  const confirmed = store.getSnapshot();
  assert.equal(confirmed.result?.paid_cents, 3000);
  assert.equal(confirmed.result?.balance_cents, 0);
  confirmReceivePayment(store, paid);
  assert.equal(store.getSnapshot(), confirmed);
  store.reset();
  store.patch({ result: { ...opened, order_id: paid.payment_id! }, phase: "complete" });
  confirmReceivePayment(store, paid);
  assert.equal(store.getSnapshot().result?.balance_cents, 2000);
  assert.deepEqual(store.getSnapshot().confirmedPaymentIntentIds, []);
});

test("distinct partial confirmations accumulate once and reject amounts beyond the balance", () => {
  const store = createReceiveWorkspace();
  store.patch({ result: opened, phase: "complete" });
  confirmReceivePayment(store, { ...paid, amount_cents: 500 });
  confirmReceivePayment(store, { ...paid, amount_cents: 500 });
  assert.equal(store.getSnapshot().result?.paid_cents, 1500);
  confirmReceivePayment(store, { ...paid, intent_id: paid.payment_id!, amount_cents: 2000 });
  assert.equal(store.getSnapshot().result?.balance_cents, 1500);
  confirmReceivePayment(store, { ...paid, intent_id: paid.payment_id!, amount_cents: 1500 });
  assert.equal(store.getSnapshot().result?.balance_cents, 0);
});

test("paid receive result survives leaving the page and returning without offering another collection", async () => {
  const port = createPaymentChannelPort(async (input) => {
    if (input.operation === "available")
      return {
        ok: true,
        data: { channels: [{ channel: "wechat", enabled: true }], can_manage: false },
      };
    if (input.operation === "list") return { ok: true, data: { intents: [] } };
    if (input.operation === "checkout") return { ok: true, data: paid };
    return { ok: false, error: { code: "SERVICE_UNAVAILABLE" } };
  });
  let store = createReceiveWorkspace();
  function Probe() {
    store = useReceiveWorkspaceAccess().store;
    return null;
  }
  const commands = createMockCommandClient();
  const app = (show: boolean) => (
    <ToastProvider>
      <ReceiveWorkspaceProvider scope="same-authorized-clerk">
        <Probe />
        {show ? <ReceivePage commandClient={commands} paymentChannelPort={port} /> : <p>工作台</p>}
      </ReceiveWorkspaceProvider>
    </ToastProvider>
  );
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => {
      renderer = create(app(true));
    });
    await act(async () => {
      store.patch({ result: opened, phase: "complete" });
    });
    const button = renderer.root
      .findAllByType("button")
      .find((node) => node.children.join("") === "微信收款码");
    assert.ok(button);
    await act(async () => {
      button.props.onClick();
    });
    assert.equal(store.getSnapshot().result?.balance_cents, 0);
    await act(async () => {
      renderer.update(app(false));
    });
    await act(async () => {
      renderer.update(app(true));
    });
    assert.equal(renderer.root.findAllByProps({ "aria-label": "扫码收款" }).length, 0);
    assert.match(JSON.stringify(renderer.toJSON()), /"data-fen":3000/u);
    assert.equal(store.getSnapshot().result?.balance_cents, 0);
  } finally {
    if (renderer) await act(async () => renderer.unmount());
  }
});

test("returning after payment while away refreshes authoritative balance and blocks collection on failure", async () => {
  let balance = 2000,
    fail = false;
  const query: QueryPort = {
    async execute<T>(name: string) {
      if (name !== "order.get") return { ok: true, data: { rows: [] } as T };
      if (fail) return { ok: false, error: { code: "NETWORK" } };
      return {
        ok: true,
        data: {
          ...opened,
          status: "open",
          customer_phone: null,
          customer_name: null,
          paid_cents: 3000 - balance,
          balance_cents: balance,
        } as T,
      };
    },
  };
  const port = createPaymentChannelPort(async (input) => {
    if (input.operation === "available")
      return {
        ok: true,
        data: { channels: [{ channel: "wechat", enabled: true }], can_manage: false },
      };
    if (input.operation === "list") return { ok: true, data: { intents: balance ? [] : [paid] } };
    return { ok: false, error: { code: "SERVICE_UNAVAILABLE" } };
  });
  const commands = createMockCommandClient();
  const store = createReceiveWorkspace();
  store.patch({ result: opened, phase: "complete" });
  function Completed() {
    useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    return (
      <ReceiveCompletedWorkspace
        store={store}
        busy={false}
        commandClient={commands}
        queryClient={query}
        paymentChannelPort={port}
      />
    );
  }
  const app = (visible: boolean) => <ToastProvider>{visible ? <Completed /> : null}</ToastProvider>;
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(app(true));
  });
  try {
    assert.ok(
      renderer.root.findAllByType("button").some((n) => n.children.join("") === "微信收款码"),
    );
    await act(async () => renderer.update(app(false)));
    balance = 0;
    await act(async () => renderer.update(app(true)));
    assert.equal(store.getSnapshot().result?.balance_cents, 0);
    assert.equal(renderer.root.findAllByProps({ "aria-label": "扫码收款" }).length, 0);
    await act(async () => renderer.update(app(false)));
    fail = true;
    await act(async () => renderer.update(app(true)));
    assert.match(JSON.stringify(renderer.toJSON()), /已暂停再次收款/u);
    assert.equal(renderer.root.findAllByProps({ "aria-label": "扫码收款" }).length, 0);
    fail = false;
    const retry = renderer.root
      .findAllByType("button")
      .find((n) => n.children.join("") === "重新核对");
    assert.ok(retry);
    await act(async () => retry.props.onClick());
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /已暂停再次收款/u);
  } finally {
    await act(async () => renderer.unmount());
  }
});
