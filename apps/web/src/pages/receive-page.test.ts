import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { TicketPreview } from "@laundry/domain";
import { ToastProvider } from "@laundry/ui";
import { createMockCommandClient } from "../commands/command-client.js";
import { createMockQueryClient } from "../commands/query-client.js";
import { ReceivePage } from "./ReceivePage.js";
import { TicketPreviewPanel } from "./TicketPreviewPanel.js";
import { buildReceiveTicketPreview } from "./ticket-preview.js";
import type { ReceiveOrderResult } from "./order-form.js";

test("ReceivePage SSR shows form fields and submit", () => {
  const commandClient = createMockCommandClient();

  const html = renderToStaticMarkup(
    createElement(ToastProvider, null, createElement(ReceivePage, { commandClient })),
  );

  assert.match(html, /开单/);
  assert.match(html, /手机号/);
  assert.match(html, /衣物明细/);
  assert.match(html, /单价（分）/);
  assert.match(html, /已付（分）/);
  assert.match(html, /确认开单/);
  assert.match(html, /整数分/);
  assert.doesNotMatch(html, /还没有价目/);
  assert.doesNotMatch(html, /价目表/);
  assert.doesNotMatch(html, /data-testid="ticket-preview"/);
});

test("ReceivePage SSR with mock queryClient renders catalog picker shell", () => {
  const commandClient = createMockCommandClient();
  const queryClient = createMockQueryClient();

  const html = renderToStaticMarkup(
    createElement(ToastProvider, null, createElement(ReceivePage, { commandClient, queryClient })),
  );

  assert.match(html, /开单/);
  assert.match(html, /价目表/);
  assert.match(html, /搜索价目/);
  assert.match(html, /data-testid="catalog-picker"/);
  // useEffect does not run under SSR — chips load client-side only
  assert.doesNotMatch(html, /还没有价目/);
  assert.doesNotMatch(html, /水洗衬衫/);
});

test("after successful receive, ticket-preview shows ticket_no", () => {
  const result: ReceiveOrderResult = Object.freeze({
    order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ticket_no: "20260722-0042",
    payable_cents: 1500,
    paid_cents: 0,
    balance_cents: 1500,
    garment_count: 1,
    garments: Object.freeze([
      Object.freeze({
        garment_id: "11111111-2222-4333-8444-555555555555",
        barcode: "BC-42",
        status: "received",
        line_index: 0,
        seq: 1,
      }),
    ]),
  });

  const preview = buildReceiveTicketPreview({
    result,
    lines: Object.freeze([
      Object.freeze({
        service_code: "wash",
        category_code: "shirt",
        unit_price_cents: 1500,
        qty: 1,
      }),
    ]),
    storeName: "测试店",
    receiveDate: "2026-07-22",
    customerName: "王五",
  });

  assert.ok(preview.lines.some((line) => line.includes("20260722-0042")));

  const html = renderToStaticMarkup(createElement(TicketPreviewPanel, { preview }));
  assert.match(html, /data-testid="ticket-preview"/);
  assert.match(html, /20260722-0042/);
  assert.match(html, /打印小票/);
  assert.match(html, /wash\/shirt/);
  assert.match(html, /¥15\.00/);
});

test("TicketPreviewPanel print button is present for browser print", () => {
  const preview: TicketPreview = Object.freeze({
    lines: Object.freeze(["店", "票单号 T-1", "合计 ¥1.00"]),
    total_text: "¥1.00",
    paid_text: "¥0.00",
    balance_text: "¥1.00",
  });
  const html = renderToStaticMarkup(createElement(TicketPreviewPanel, { preview }));
  assert.match(html, /data-testid="ticket-print-button"/);
  assert.match(html, /data-testid="ticket-preview-body"/);
});
