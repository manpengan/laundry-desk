import assert from "node:assert/strict";
import test from "node:test";
import { createElement, useSyncExternalStore } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { ToastProvider } from "@laundry/ui";
import type { ChannelIntent, DesktopPaymentChannelInput } from "@laundry/contracts";
import { FULL_STORE_FEATURES } from "../auth/permissions.js";
import { createMockAuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { createMockCommandClient } from "../commands/command-client.js";
import { createPaymentChannelPort } from "../host/payment-channel-port.js";
import { ChannelCollectCard } from "./ChannelCollectCard.js";
import { PaymentChannelCollection } from "./PaymentChannelCollection.js";
import { PaymentChannelReconcile } from "./PaymentChannelReconcile.js";
import { ReceiveTicketResult } from "./ReceiveTicketResult.js";
import { createReceiveWorkspace } from "./receive-workspace.js";
import { confirmReceivePayment } from "./receive-payment.js";
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const id = "11111111-1111-4111-8111-111111111111";
const session: SessionView = {
  session: {
    session_id: id,
    session_version: 1,
    org_id: id,
    store_id: id,
    staff_id: id,
    device_id: id,
    permission_version: 1,
  },
  role: "admin",
  features: FULL_STORE_FEATURES,
  display: {
    store_name: "合成测试店",
    staff_name: "测试管理员",
    org_code: "TEST",
    store_code: "SYNTHETIC",
  },
};
const failed = { ok: false, error: { code: "SERVICE_UNAVAILABLE", message: "unavailable" } };
const available = {
  ok: true,
  data: {
    channels: [
      { channel: "wechat", enabled: true },
      { channel: "alipay", enabled: true },
    ],
    can_manage: false,
  },
};
const intent = (patch: Partial<ChannelIntent> = {}): ChannelIntent => ({
  intent_id: "22222222-2222-4222-8222-222222222222",
  order_id: id,
  purpose: "order",
  channel: "wechat",
  amount_cents: 100,
  state: "unknown",
  qr_url: null,
  payment_id: null,
  created_at: new Date(Date.now() - 3_600_000).toISOString(),
  expires_at: new Date(Date.now() - 1_800_000).toISOString(),
  error_code: "CHANNEL_TRANSPORT_FAILED",
  ...patch,
});
function button(renderer: ReactTestRenderer, label: string): () => void {
  const node = renderer.root
    .findAllByType("button")
    .find((item) => item.children.join("") === label);
  assert.ok(node, label);
  return node.props.onClick as () => void;
}
const text = (renderer: ReactTestRenderer) => JSON.stringify(renderer.toJSON());
function card(port: ReturnType<typeof createPaymentChannelPort>, balance = 100) {
  return createElement(
    ToastProvider,
    null,
    createElement(ChannelCollectCard, {
      port,
      order: { order_id: id, status: "open", balance_cents: balance },
      refreshKey: 0,
      disabled: false,
      onPaid: () => undefined,
    }),
  );
}

test("pickup card resends a lost checkout with its key and then shows the open intent", async () => {
  const checkouts: DesktopPaymentChannelInput[] = [];
  let lists = 0;
  const port = createPaymentChannelPort(async (input) => {
    if (input.operation === "available") return available;
    if (input.operation === "list") {
      lists++;
      return { ok: true, data: { intents: lists >= 3 ? [intent({ state: "pending" })] : [] } };
    }
    if (input.operation === "checkout") {
      checkouts.push(input);
      throw new Error("lost response");
    }
    return failed;
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(card(port));
  });
  try {
    await act(async () => {
      button(renderer, "微信收款码")();
    });
    await act(async () => {
      button(renderer, "微信收款码")();
    });
    assert.equal(checkouts.length, 2);
    assert.deepEqual(checkouts[0], checkouts[1]);
    // The second failure re-listed and found the intent the lost answer had created.
    assert.match(text(renderer), /等待顾客付款/u);
    assert.ok(
      renderer.root.findAllByType("button").some((b) => b.children.join("") === "查询结果"),
    );
  } finally {
    await act(() => renderer.unmount());
  }
});

test("pickup card stays hidden when nothing is owed or no channel is enabled", async () => {
  const quiet = createPaymentChannelPort(async (input) =>
    input.operation === "list"
      ? { ok: true, data: { intents: [] } }
      : {
          ok: true,
          data: { channels: [{ channel: "wechat", enabled: false }], can_manage: false },
        },
  );
  for (const element of [
    card(quiet),
    card(
      createPaymentChannelPort(async () => available),
      0,
    ),
  ]) {
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(element);
    });
    assert.equal(renderer.root.findAllByType("section").length, 0);
    await act(() => renderer.unmount());
  }
});

test("late pickup checkout answer after unmount starts no polling", async () => {
  let settle: ((value: unknown) => void) | undefined;
  let calls = 0;
  const port = createPaymentChannelPort(async (input) => {
    if (input.operation === "available") return available;
    if (input.operation === "list") return { ok: true, data: { intents: [] } };
    calls++;
    return new Promise<unknown>((resolve) => {
      settle = resolve;
    });
  });
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(card(port));
  });
  await act(async () => {
    button(renderer, "微信收款码")();
  });
  await act(() => renderer.unmount());
  await act(async () => {
    settle!({ ok: true, data: intent({ state: "pending" }) });
  });
  assert.equal(calls, 1);
});

test("changing statement date cancels a late file read before any reconciliation request", async () => {
  let finish: ((text: string) => void) | undefined;
  let calls = 0;
  const port = createPaymentChannelPort(async () => {
    calls++;
    return failed;
  });
  let renderer!: ReactTestRenderer;
  await act(() => {
    renderer = create(createElement(PaymentChannelReconcile, { port }));
  });
  const date = () =>
    renderer.root.findAllByType("input").find((node) => node.props.type === "date")!;
  const file = () =>
    renderer.root.findAllByType("input").find((node) => node.props.type === "file")!;
  try {
    await act(() => {
      (date().props.onChange as (e: unknown) => void)({ target: { value: "2026-10-03" } });
    });
    await act(() => {
      (file().props.onChange as (e: unknown) => void)({
        target: {
          files: [
            {
              size: 100,
              arrayBuffer: () =>
                new Promise<ArrayBuffer>((resolve) => {
                  finish = (text) => resolve(new TextEncoder().encode(text).buffer as ArrayBuffer);
                }),
            },
          ],
          value: "file",
        },
      });
    });
    await act(() => {
      (date().props.onChange as (e: unknown) => void)({ target: { value: "2026-10-04" } });
    });
    await act(async () => {
      finish!("商户订单号,渠道订单号,金额分,类型,商户退款号\nld1,wx2,100,收款,");
    });
    const submit = renderer.root
      .findAllByType("button")
      .find((node) => node.children.join("") === "提交对账")!;
    assert.equal(submit.props.disabled, true);
    assert.equal(calls, 0);
  } finally {
    await act(() => renderer.unmount());
  }
});

async function openRecords(port: ReturnType<typeof createPaymentChannelPort>) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(PaymentChannelCollection, {
        port,
        session,
        authClient: createMockAuthClient(),
        commandClient: createMockCommandClient(),
      }),
    );
  });
  await act(() => {
    (
      renderer.root.findByProps({ "aria-label": "最近收款记录" }).findByType("button").props
        .onClick as () => void
    )();
  });
  return renderer;
}
function type(renderer: ReactTestRenderer, name: string, value: string) {
  const field = renderer.root.findAll((node) => node.type === "input" && node.props.name === name);
  assert.equal(field.length, 1, name);
  (field[0]!.props.onChange as (e: unknown) => void)({ target: { value } });
}

test("expired unconfirmed collection can be written off with a reason and password", async () => {
  const resolves: DesktopPaymentChannelInput[] = [];
  const port = createPaymentChannelPort(async (input) => {
    if (input.operation === "list") return { ok: true, data: { intents: [intent()] } };
    if (input.operation === "refunds.list") return { ok: true, data: { refunds: [] } };
    if (input.operation === "resolve") {
      resolves.push(input);
      return resolves.length === 1
        ? { ok: false, error: { code: "RESOURCE_UNAVAILABLE", message: "x" } }
        : { ok: true, data: intent({ state: "closed", error_code: "CHANNEL_MANUAL_CLOSED" }) };
    }
    return failed;
  });
  const renderer = await openRecords(port);
  try {
    assert.match(text(renderer), /确认未收款并核销/u);
    await act(() => {
      type(renderer, "channel-resolve-password", "secret");
    });
    await act(async () => {
      button(renderer, "确认未收款并核销")();
    });
    assert.equal(resolves.length, 0, "a reason is required before any request");
    for (const attempt of [1, 2]) {
      await act(() => {
        type(renderer, "channel-resolve-note", "商户后台无此交易");
        type(renderer, "channel-resolve-password", "secret");
      });
      await act(async () => {
        button(renderer, "确认未收款并核销")();
      });
      assert.equal(resolves.length, attempt);
    }
    assert.deepEqual(resolves[0], {
      operation: "resolve",
      body: { intent_id: intent().intent_id, note: "商户后台无此交易", password: "secret" },
    });
    assert.match(text(renderer), /店长已人工核销/u);
    assert.doesNotMatch(text(renderer), /确认未收款并核销/u);
  } finally {
    await act(() => renderer.unmount());
  }
});

test("write-off is not offered before the expiry grace has passed", async () => {
  const fresh = intent({ expires_at: new Date(Date.now() + 60_000).toISOString() });
  const port = createPaymentChannelPort(async (input) =>
    input.operation === "list"
      ? { ok: true, data: { intents: [fresh] } }
      : { ok: true, data: { refunds: [] } },
  );
  const renderer = await openRecords(port);
  try {
    assert.doesNotMatch(text(renderer), /确认未收款并核销/u);
    assert.match(text(renderer), /关闭未支付订单/u);
  } finally {
    await act(() => renderer.unmount());
  }
});

test("a customer can prepay by scan right after an order is opened", async () => {
  const opened = {
    order_id: id,
    ticket_no: "20261005-0001",
    pickup_code: "P1",
    payable_cents: 3_000,
    paid_cents: 1_000,
    balance_cents: 2_000,
    discount_cents: 0,
    discount_source: "none" as const,
    discount_bps: 0,
    waivers: { skip_ticket_print: false, skip_label_print: false, skip_rack_assignment: false },
    garment_count: 1,
    garments: [],
  };
  const port = createPaymentChannelPort(async (input) => {
    if (input.operation === "available") return available;
    if (input.operation === "list") return { ok: true, data: { intents: [] } };
    if (input.operation === "checkout")
      return { ok: true, data: intent({ amount_cents: 2_000, state: "paid", error_code: null }) };
    return failed;
  });
  const store = createReceiveWorkspace();
  store.patch({ result: opened, phase: "complete" });
  function Result() {
    const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
    return createElement(ReceiveTicketResult, {
      busy: false,
      commandClient: createMockCommandClient(),
      notify: () => undefined,
      preview: null,
      queuePrintEnabled: false,
      result: state.result,
      paymentChannelPort: port,
      onPaymentConfirmed: (paid) => confirmReceivePayment(store, paid),
    });
  }
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(ToastProvider, null, createElement(Result)));
  });
  try {
    const collect = button(renderer, "微信收款码");
    await act(async () => {
      collect();
    });
    // The confirmed amount settles the result shown, and the card leaves with the debt.
    assert.equal(renderer.root.findAllByProps({ "aria-label": "扫码收款" }).length, 0);
    const html = text(renderer);
    assert.match(html, /"data-fen":3000/u);
    assert.match(html, /已收到微信付款/u);
    assert.doesNotMatch(html, /"data-fen":2000/u);
  } finally {
    await act(() => renderer.unmount());
  }
});
