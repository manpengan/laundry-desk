import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";
import { createMockQueryClient } from "../commands/query-client.js";
import {
  localYmd,
  OrdersList,
  parseOrderListRows,
  unwrapQueryResult,
  type OrderListRowView,
} from "./OrdersList.js";

const SAMPLE_ROW: OrderListRowView = Object.freeze({
  order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  ticket_no: "20260722-0001",
  status: "open",
  customer_phone: "13800000111",
  customer_name: "甲",
  payable_cents: 3000,
  paid_cents: 500,
  balance_cents: 2500,
  created_at: 1_721_606_400,
  garment_count: 2,
});

test("localYmd formats local calendar day", () => {
  assert.equal(localYmd(new Date(2026, 6, 22, 9, 30, 0)), "2026-07-22");
});

test("parseOrderListRows accepts documented result shape", () => {
  const parsed = parseOrderListRows({ orders: [SAMPLE_ROW] });
  assert.deepEqual(parsed, [SAMPLE_ROW]);
  assert.equal(parseOrderListRows({ orders: [{ order_id: "x" }] }), null);
  assert.equal(parseOrderListRows(null), null);
  assert.deepEqual(parseOrderListRows({ orders: [] }), []);
});

test("unwrapQueryResult peels bus envelope", () => {
  assert.deepEqual(unwrapQueryResult({ execution: "executed", result: { orders: [SAMPLE_ROW] } }), {
    orders: [SAMPLE_ROW],
  });
  assert.deepEqual(unwrapQueryResult({ orders: [] }), { orders: [] });
});

test("OrdersList SSR shell shows date control and load button", () => {
  const queryClient = createMockQueryClient();
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(OrdersList, {
        queryClient,
        defaultDate: "2026-07-22",
        autoLoad: false,
      }),
    ),
  );

  assert.match(html, /近期订单/);
  assert.match(html, /营业日/);
  assert.match(html, /刷新列表/);
  assert.match(html, /data-testid="orders-date-input"/);
  assert.match(html, /data-testid="orders-load-btn"/);
  assert.match(html, /data-testid="orders-list"/);
  assert.match(html, /暂无订单/);
  assert.doesNotMatch(html, /#ff0000/i);
  assert.doesNotMatch(html, /rgb\(/i);
});

test("mock query client returns empty order.list", async () => {
  const queryClient = createMockQueryClient();
  const res = await queryClient.execute("order.list", { limit: 10 });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const body = unwrapQueryResult(res.data) as { orders: unknown[] };
  assert.deepEqual(body.orders, []);
});
