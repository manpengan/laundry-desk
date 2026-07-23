import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";
import { createMockQueryClient } from "../commands/query-client.js";
import type { CommandResult } from "../commands/types.js";
import { parseOrderGetResult, unwrapCommandResult, type OrderGetResult } from "./order-form.js";
import { OrderDetailContent, OrderDetailDrawer } from "./OrderDetailDrawer.js";
import { OrdersList } from "./OrdersList.js";

const SAMPLE_ORDER: OrderGetResult = Object.freeze({
  order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  ticket_no: "20260722-0001",
  status: "open",
  customer_phone: "13800000111",
  customer_name: "甲",
  payable_cents: 3000,
  paid_cents: 500,
  balance_cents: 2500,
  garments: Object.freeze([
    Object.freeze({
      garment_id: "11111111-2222-4333-8444-555555555555",
      barcode: "TK-001",
      status: "received",
      line_index: 0,
      seq: 1,
      unit_price_cents: 1500,
    }),
    Object.freeze({
      garment_id: "22222222-3333-4444-8555-666666666666",
      barcode: "TK-002",
      status: "picked_up",
      line_index: 0,
      seq: 2,
      unit_price_cents: 1500,
    }),
  ]),
});

function mockOrderGetClient(order: OrderGetResult = SAMPLE_ORDER) {
  return createMockQueryClient(async <T = unknown>(name: string): Promise<CommandResult<T>> => {
    if (name === "order.get") {
      return Object.freeze({
        ok: true as const,
        data: Object.freeze({
          execution: "executed",
          result: order,
        }) as T,
      });
    }
    if (name === "order.list") {
      return Object.freeze({
        ok: true as const,
        data: Object.freeze({
          execution: "executed",
          result: Object.freeze({ orders: Object.freeze([]) }),
        }) as T,
      });
    }
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({ code: "NOT_FOUND", message: `unexpected query ${name}` }),
    });
  });
}

test("parseOrderGetResult peels mock order.get payload fields", () => {
  const envelope = {
    execution: "executed",
    result: {
      order_id: SAMPLE_ORDER.order_id,
      ticket_no: SAMPLE_ORDER.ticket_no,
      status: SAMPLE_ORDER.status,
      customer_phone: SAMPLE_ORDER.customer_phone,
      customer_name: SAMPLE_ORDER.customer_name,
      payable_cents: SAMPLE_ORDER.payable_cents,
      paid_cents: SAMPLE_ORDER.paid_cents,
      balance_cents: SAMPLE_ORDER.balance_cents,
      garments: SAMPLE_ORDER.garments,
    },
  };
  const unwrapped = unwrapCommandResult(envelope);
  const parsed = parseOrderGetResult(unwrapped);
  assert.ok(parsed);
  assert.equal(parsed?.ticket_no, "20260722-0001");
  assert.equal(parsed?.customer_phone, "13800000111");
  assert.equal(parsed?.payable_cents, 3000);
  assert.equal(parsed?.paid_cents, 500);
  assert.equal(parsed?.balance_cents, 2500);
  assert.equal(parsed?.garments.length, 2);
  assert.equal(parsed?.garments[0]?.barcode, "TK-001");
  assert.equal(parsed?.garments[0]?.unit_price_cents, 1500);
  assert.equal(parseOrderGetResult({ ticket_no: "x" }), null);
});

test("mock query client returns seeded order.get", async () => {
  const queryClient = mockOrderGetClient();
  const res = await queryClient.execute("order.get", {
    order_id: SAMPLE_ORDER.order_id,
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  const parsed = parseOrderGetResult(unwrapCommandResult(res.data));
  assert.equal(parsed?.order_id, SAMPLE_ORDER.order_id);
  assert.equal(parsed?.garments[1]?.status, "picked_up");
});

test("OrderDetailContent SSR shows ticket, money, garments, photo placeholder", () => {
  const html = renderToStaticMarkup(createElement(OrderDetailContent, { order: SAMPLE_ORDER }));

  assert.match(html, /20260722-0001/);
  assert.match(html, /data-testid="order-detail-ticket"/);
  assert.match(html, /data-testid="order-detail-phone"/);
  assert.match(html, /13800000111/);
  assert.match(html, /甲/);
  assert.match(html, /data-testid="order-detail-payable"/);
  assert.match(html, /data-testid="order-detail-paid"/);
  assert.match(html, /data-testid="order-detail-balance"/);
  assert.match(html, /data-fen="3000"/);
  assert.match(html, /data-fen="500"/);
  assert.match(html, /data-fen="2500"/);
  assert.match(html, /TK-001/);
  assert.match(html, /TK-002/);
  assert.match(html, /照片 M3/);
  assert.match(html, /data-testid="order-detail-photos"/);
  assert.match(html, /data-testid="order-detail-garments"/);
  assert.doesNotMatch(html, /#ff0000/i);
  assert.doesNotMatch(html, /rgb\(/i);
});

test("OrderDetailDrawer SSR open shell shows actions with mock order.get client", () => {
  const queryClient = mockOrderGetClient();
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(OrderDetailDrawer, {
        open: true,
        orderId: SAMPLE_ORDER.order_id,
        queryClient,
        onClose: () => undefined,
        onPickup: () => undefined,
      }),
    ),
  );

  assert.match(html, /订单详情/);
  assert.match(html, /data-testid="order-detail-drawer"/);
  assert.match(html, /data-testid="order-detail-pickup-btn"/);
  assert.match(html, /去取衣/);
  assert.match(html, /data-testid="order-detail-close-btn"/);
  assert.match(html, /关闭/);
  assert.doesNotMatch(html, /#ff0000/i);
});

test("OrderDetailDrawer SSR closed omits drawer body", () => {
  const queryClient = mockOrderGetClient();
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(OrderDetailDrawer, {
        open: false,
        orderId: SAMPLE_ORDER.order_id,
        queryClient,
        onClose: () => undefined,
      }),
    ),
  );
  assert.doesNotMatch(html, /data-testid="order-detail-drawer"/);
  assert.doesNotMatch(html, /ld-drawer/);
  assert.doesNotMatch(html, /去取衣/);
});

test("OrdersList SSR still wires detail path chrome", () => {
  const queryClient = mockOrderGetClient();
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(OrdersList, {
        queryClient,
        defaultDate: "2026-07-22",
        autoLoad: false,
        onOpenPickup: () => undefined,
      }),
    ),
  );
  assert.match(html, /点击行打开订单详情/);
  assert.match(html, /data-testid="orders-list"/);
  assert.doesNotMatch(html, /跳转取衣并预填/);
});
