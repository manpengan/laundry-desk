import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { FULL_STORE_FEATURES } from "../auth/permissions.js";
import { createMockAuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { createMockCommandClient } from "../commands/command-client.js";
import type { QueryPort } from "../commands/types.js";
import { createPaymentChannelPort } from "../host/payment-channel-port.js";
import { PaymentChannelCollection } from "./PaymentChannelCollection.js";
import { PaymentChannelReconcile } from "./PaymentChannelReconcile.js";
import type { DesktopPaymentChannelInput } from "@laundry/contracts";
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
const query: QueryPort = {
  async execute<T>() {
    return {
      ok: true,
      data: {
        orders: [
          {
            order_id: id,
            ticket_no: "TEST-1",
            status: "received",
            customer_phone: null,
            customer_name: "测试顾客",
            payable_cents: 100,
            paid_cents: 0,
            balance_cents: 100,
            created_at: Date.now(),
            pickup_code: "123456",
            matched_by: "ticket_no",
          },
        ],
      } as T,
    };
  },
};
const failed = { ok: false, error: { code: "SERVICE_UNAVAILABLE", message: "unavailable" } };
function button(renderer: ReactTestRenderer, label: string): () => void {
  const node = renderer.root
    .findAllByType("button")
    .find((item) => item.children.join("") === label);
  assert.ok(node, label);
  return node.props.onClick as () => void;
}
async function pickOrder(renderer: ReactTestRenderer) {
  await act(() => {
    (renderer.root.findByType("input").props.onChange as (e: unknown) => void)({
      target: { value: "TEST-1" },
    });
  });
  await act(async () => {
    button(renderer, "查找订单")();
  });
  await act(() => {
    (renderer.root.findAllByType("select")[0]!.props.onChange as (e: unknown) => void)({
      target: { value: id },
    });
  });
}
test("uncertain collection retries preserve the idempotency key and cannot switch channels", async () => {
  const calls: DesktopPaymentChannelInput[] = [];
  const port = createPaymentChannelPort(async (input) => {
    calls.push(input);
    throw new Error("lost response");
  });
  let renderer!: ReactTestRenderer;
  await act(() => {
    renderer = create(
      createElement(PaymentChannelCollection, {
        port,
        session,
        authClient: createMockAuthClient(),
        commandClient: createMockCommandClient(),
        queryClient: query,
      }),
    );
  });
  try {
    await pickOrder(renderer);
    await act(async () => {
      button(renderer, "生成收款码")();
    });
    await act(async () => {
      button(renderer, "生成收款码")();
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], calls[1]);
    assert.equal(calls[0]?.operation, "checkout");
    await act(() => {
      (renderer.root.findAllByType("select")[1]!.props.onChange as (e: unknown) => void)({
        target: { value: "alipay" },
      });
    });
    await act(async () => {
      button(renderer, "生成收款码")();
    });
    assert.equal(calls.length, 2);
    assert.match(JSON.stringify(renderer.toJSON()), /前次收款结果尚未确认/u);
  } finally {
    await act(() => renderer.unmount());
  }
});
test("late payment result after unmount cannot produce further payment calls", async () => {
  let settle: ((value: unknown) => void) | undefined;
  let count = 0;
  const port = createPaymentChannelPort(async () => {
    count++;
    return new Promise<unknown>((resolve) => {
      settle = resolve;
    });
  });
  let renderer!: ReactTestRenderer;
  await act(() => {
    renderer = create(
      createElement(PaymentChannelCollection, {
        port,
        session,
        authClient: createMockAuthClient(),
        commandClient: createMockCommandClient(),
        queryClient: query,
      }),
    );
  });
  await pickOrder(renderer);
  await act(async () => {
    button(renderer, "生成收款码")();
  });
  await act(() => renderer.unmount());
  await act(async () => {
    settle!(failed);
  });
  assert.equal(count, 1);
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
              text: () =>
                new Promise<string>((resolve) => {
                  finish = resolve;
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

test("querying an old paid intent cannot clear a newer unknown collection attempt", async () => {
  const oldId = "22222222-2222-4222-8222-222222222222";
  const old = {
    intent_id: oldId,
    order_id: id,
    purpose: "order",
    channel: "wechat",
    amount_cents: 100,
    state: "paid",
    qr_url: null,
    payment_id: oldId,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60000).toISOString(),
    error_code: null,
  };
  const checkouts: DesktopPaymentChannelInput[] = [];
  const port = createPaymentChannelPort(async (input) => {
    if (input.operation === "checkout") {
      checkouts.push(input);
      throw new Error("unknown response");
    }
    if (input.operation === "list") return { ok: true, data: { intents: [old] } };
    if (input.operation === "refunds.list") return { ok: true, data: { refunds: [] } };
    return { ok: true, data: old };
  });
  let renderer!: ReactTestRenderer;
  await act(() => {
    renderer = create(
      createElement(PaymentChannelCollection, {
        port,
        session,
        authClient: createMockAuthClient(),
        commandClient: createMockCommandClient(),
        queryClient: query,
      }),
    );
  });
  try {
    await pickOrder(renderer);
    await act(async () => {
      button(renderer, "生成收款码")();
    });
    await act(async () => {
      button(renderer, "刷新最近收退款记录")();
    });
    await act(() => {
      (
        renderer.root.findByProps({ "aria-label": "最近收款记录" }).findByType("button").props
          .onClick as () => void
      )();
    });
    await act(async () => {
      button(renderer, "查询渠道最新结果")();
    });
    await act(async () => {
      button(renderer, "生成收款码")();
    });
    assert.equal(checkouts.length, 2);
    assert.deepEqual(checkouts[0], checkouts[1]);
  } finally {
    await act(() => renderer.unmount());
  }
});
