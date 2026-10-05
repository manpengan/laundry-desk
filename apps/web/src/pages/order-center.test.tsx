import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { ToastProvider } from "@laundry/ui";
import { createMockCommandClient } from "../commands/command-client.js";
import { createMockQueryClient } from "../commands/query-client.js";
import { OrderCenterFilters } from "./OrderCenterFilters.js";
import { DebtPage } from "./DebtPage.js";
import { CustomersPage } from "./CustomersPage.js";
import { CustomerWorkspace } from "./CustomerWorkspace.js";
import { parseOrderPage } from "./use-order-page.js";
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const customer = {
  customer_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  phone: "13800000001",
  name: "合成客户",
  note: null,
  updated_at: 1,
};
const order = (index: number) => ({
  order_id: `order-${index}`,
  ticket_no: `TEST-${index}`,
  status: "open",
  customer_phone: customer.phone,
  customer_name: customer.name,
  payable_cents: 3000,
  paid_cents: 1000,
  balance_cents: 2000,
  created_at: index,
});
const button = (view: ReactTestRenderer, label: string) => {
  const found = view.root.findAllByType("button").find((node) => node.children.includes(label));
  assert.ok(found, label);
  return found;
};
const click = async (view: ReactTestRenderer, label: string) =>
  act(async () => (button(view, label).props.onClick as () => void)());

test("order center loads all dates and pages the 51st order; a failed page keeps old rows and retries exact request", async () => {
  const requests: Record<string, unknown>[] = [];
  let fail = true;
  const queryClient = createMockQueryClient(async <T,>(name: string, body?: unknown) => {
    assert.equal(name, "order.list");
    const input = body as Record<string, number>;
    requests.push(input);
    if (input.offset === 50 && fail)
      return { ok: false as const, error: { code: "RESOURCE_UNAVAILABLE" } };
    const rows = input.offset === 0 ? Array.from({ length: 50 }, (_, i) => order(i)) : [order(50)];
    return {
      ok: true as const,
      data: { orders: rows, total: 51, offset: input.offset, limit: 50 } as T,
    };
  });
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(createElement(ToastProvider, null, createElement(DebtPage, { queryClient })));
  });
  try {
    assert.deepEqual(requests[0], { offset: 0, limit: 50 });
    await click(view, "下一页");
    assert.match(JSON.stringify(view.toJSON()), /上次成功读取的结果/);
    assert.equal(view.root.findAllByProps({ "data-testid": "debt-row" }).length, 50);
    fail = false;
    await click(view, "重试");
    assert.deepEqual(requests.at(-1), { offset: 50, limit: 50 });
    assert.equal(view.root.findAllByProps({ "data-testid": "debt-row" }).length, 1);
    assert.match(JSON.stringify(view.toJSON()), /TEST-50/);
    assert.equal(button(view, "下一页").props.disabled, true);
  } finally {
    await act(() => view.unmount());
  }
});
test("customer history reaches order 21 by stable customer ID and errors do not become empty history", async () => {
  const requests: Record<string, unknown>[] = [];
  let failed = false;
  const queryClient = createMockQueryClient(async <T,>(name: string, body?: unknown) => {
    if (name !== "order.list")
      return { ok: false as const, error: { code: "RESOURCE_UNAVAILABLE" } };
    const input = body as Record<string, number>;
    requests.push(input);
    if (failed) throw new Error("synthetic network failure");
    return {
      ok: true as const,
      data: {
        orders: input.offset === 0 ? Array.from({ length: 20 }, (_, i) => order(i)) : [order(20)],
        total: 21,
        offset: input.offset,
        limit: 20,
      } as T,
    };
  });
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(
      createElement(
        ToastProvider,
        null,
        createElement(CustomersPage, {
          queryClient,
          commandClient: createMockCommandClient(),
          autoLoad: false,
          initialSelected: customer,
        }),
      ),
    );
  });
  try {
    assert.deepEqual(requests[0], { customer_id: customer.customer_id, offset: 0, limit: 20 });
    failed = true;
    await click(view, "下一页");
    assert.match(JSON.stringify(view.toJSON()), /客户历史暂时无法加载/);
    assert.equal(
      view.root.findAllByProps({ "data-testid": "customer-detail-order-btn" }).length,
      20,
    );
    failed = false;
    const notice = view.root.findByProps({ "data-testid": "customer-history-error" });
    await act(async () => (notice.findByType("button").props.onClick as () => void)());
    assert.equal(
      view.root.findAllByProps({ "data-testid": "customer-detail-order-btn" }).length,
      1,
    );
    assert.match(JSON.stringify(view.toJSON()), /TEST-20/);
  } finally {
    await act(() => view.unmount());
  }
});
test("customer task sections preserve mounted profile and isolate risk actions under a persistent target", async () => {
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(
      createElement(
        ToastProvider,
        null,
        createElement(CustomerWorkspace, {
          customer,
          orders: [],
          printJobs: [],
          ordersBusy: false,
          queryClient: createMockQueryClient(),
          commandClient: createMockCommandClient(),
          toast: {
            push: () => undefined,
            dismiss: () => undefined,
            dismissStale: () => undefined,
          },
          onClose: () => undefined,
          onOpenOrder: () => undefined,
          onRemoved: () => undefined,
          onReselect: () => undefined,
        }),
      ),
    );
  });
  try {
    const profile = view.root.findByProps({ id: "customer-section-profile" });
    const risk = view.root.findByProps({ id: "customer-section-risk" });
    assert.equal(profile.props.hidden, true);
    assert.equal(risk.props.hidden, true);
    await click(view, "客户档案与预约");
    const note = profile.findByProps({ name: "customer-edit-note" });
    await act(() =>
      (note.props.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "未保存的合成备注" },
      }),
    );
    assert.equal(profile.props.hidden, false);
    assert.equal(risk.props.hidden, true);
    await click(view, "合并与隐私处理");
    assert.equal(profile.props.hidden, true);
    assert.equal(risk.props.hidden, false);
    assert.equal(risk.findAllByProps({ name: "customer-edit-phone" }).length, 0);
    await click(view, "客户档案与预约");
    assert.equal(note.props.value, "未保存的合成备注");
    assert.match(JSON.stringify(view.toJSON()), /当前客户：/);
    assert.match(JSON.stringify(view.toJSON()), /13800000001/);
  } finally {
    await act(() => view.unmount());
  }
});
test("page parser rejects partial metadata and impossible totals", () => {
  for (const result of [
    { orders: [order(1)] },
    { orders: [order(1)], total: 0, offset: 0, limit: 20 },
    { orders: [], total: 1, offset: -1, limit: 20 },
    { orders: [], total: 0, offset: 0, limit: 100 },
  ])
    assert.equal(parseOrderPage(result), null);
});

test("order filters submit the full bounded server filter and reject an inverted date range", async () => {
  const searches: Readonly<Record<string, unknown>>[] = [];
  let view!: ReactTestRenderer;
  await act(() => {
    view = create(
      createElement(OrderCenterFilters, { busy: false, onSearch: (body) => searches.push(body) }),
    );
  });
  try {
    const selects = view.root.findAllByType("select");
    const inputs = view.root.findAllByType("input");
    const change = (node: (typeof selects)[number], value: string) =>
      act(() =>
        (node.props.onChange as (event: { target: { value: string } }) => void)({
          target: { value },
        }),
      );
    await change(selects[0]!, "debt");
    await change(selects[1]!, "open");
    await change(inputs[0]!, " TEST-1 ");
    await change(inputs[1]!, "合成");
    await change(inputs[2]!, "2026-10-01");
    await change(inputs[3]!, "2020-01-01");
    const submit = () =>
      act(() =>
        (
          view.root.findByType("form").props.onSubmit as (event: {
            preventDefault: () => void;
          }) => void
        )({ preventDefault() {} }),
      );
    await submit();
    assert.equal(searches.length, 0);
    assert.match(JSON.stringify(view.toJSON()), /开始日期不能晚于结束日期/);
    await change(inputs[3]!, "2026-10-06");
    await submit();
    assert.deepEqual(searches[0], {
      min_balance_cents: 1,
      status: "open",
      ticket_no: "TEST-1",
      customer_query: "合成",
      date_from: "2026-10-01",
      date_to: "2026-10-06",
    });
  } finally {
    await act(() => view.unmount());
  }
});

test("a completed mutation for old customer A cannot close or reselect newer customer B", async () => {
  const second = {
    ...customer,
    customer_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    name: "客户B",
    phone: "13800000002",
  };
  const queryClient = createMockQueryClient(async <T,>(name: string) => {
    const data =
      name === "customer.search"
        ? {
            customers: [customer, second].map((row) => ({
              customer_id: row.customer_id,
              phone_masked: row.phone,
              name: row.name,
              updated_at: row.updated_at,
            })),
          }
        : name === "customer.get"
          ? second
          : name === "order.list"
            ? { orders: [], total: 0, offset: 0, limit: 20 }
            : {};
    return { ok: true as const, data: data as T };
  });
  let view!: ReactTestRenderer;
  await act(async () => {
    view = create(
      createElement(
        ToastProvider,
        null,
        createElement(CustomersPage, {
          queryClient,
          commandClient: createMockCommandClient(),
          initialSelected: customer,
        }),
      ),
    );
  });
  try {
    const old = view.root.findByType(CustomerWorkspace).props as React.ComponentProps<
      typeof CustomerWorkspace
    >;
    const rows = view.root
      .findAllByType("button")
      .filter((node) => node.props["data-testid"] === "customers-row");
    await act(async () => (rows[1]!.props.onClick as () => void)());
    assert.equal(
      view.root.findByType(CustomerWorkspace).props.customer.customer_id,
      second.customer_id,
    );
    await act(async () => {
      old.onRemoved();
      old.onReselect();
    });
    assert.equal(
      view.root.findByType(CustomerWorkspace).props.customer.customer_id,
      second.customer_id,
    );
  } finally {
    await act(() => view.unmount());
  }
});
