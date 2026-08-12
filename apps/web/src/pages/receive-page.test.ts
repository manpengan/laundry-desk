import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import type { TicketPreview } from "@laundry/domain";
import { ToastProvider } from "@laundry/ui";
import { createMockCommandClient } from "../commands/command-client.js";
import { createMockQueryClient } from "../commands/query-client.js";
import { enqueueTicketPrint, notifyReceiveSuccess, ReceivePage } from "./ReceivePage.js";
import { ReceiveResult } from "./ReceiveResult.js";
import { TicketPrintWaiverNotice } from "./TicketPrintWaiverNotice.js";
import { createTicketPrintAction, TicketPreviewPanel } from "./TicketPreviewPanel.js";
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
  assert.match(html, /价目单价/);
  assert.match(html, /首笔收款（分）/);
  assert.match(html, /确认开单/);
  assert.match(html, /服务端重新定价/);
  assert.match(html, /暂存挂单/);
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

test("receive exposes fixed fee choices and keeps manual discount admin-only", () => {
  const commandClient = createMockCommandClient();
  const admin = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(ReceivePage, { commandClient, role: "admin" }),
    ),
  );
  const staff = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(ReceivePage, { commandClient, role: "staff" }),
    ),
  );

  assert.match(admin, /店长折扣（分）/u);
  assert.match(admin, /加急（/u);
  assert.match(admin, /运费（/u);
  assert.doesNotMatch(admin, /附加（分）|加急（分）|运费（分）/u);
  assert.doesNotMatch(staff, /店长折扣（分）/u);
});

test("after successful receive, ticket-preview shows ticket_no", () => {
  const result: ReceiveOrderResult = Object.freeze({
    order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ticket_no: "20260722-0042",
    pickup_code: "P202607220042",
    payable_cents: 1500,
    paid_cents: 0,
    balance_cents: 1500,
    discount_cents: 250,
    discount_source: "customer",
    discount_bps: 1_250,
    waivers: Object.freeze({
      skip_ticket_print: true,
      skip_label_print: false,
      skip_rack_assignment: true,
    }),
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

test("ReceiveResult shows the authoritative discount policy and operational waivers", () => {
  const result: ReceiveOrderResult = Object.freeze({
    order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ticket_no: "20260812-0042",
    pickup_code: "P202608120042",
    payable_cents: 1_750,
    paid_cents: 0,
    balance_cents: 1_750,
    discount_cents: 250,
    discount_source: "customer",
    discount_bps: 1_250,
    waivers: Object.freeze({
      skip_ticket_print: true,
      skip_label_print: false,
      skip_rack_assignment: true,
    }),
    garment_count: 0,
    garments: Object.freeze([]),
  });

  const html = renderToStaticMarkup(createElement(ReceiveResult, { result }));

  assert.match(html, /data-testid="receive-discount-source"/u);
  assert.match(html, /顾客专属 12\.5%/u);
  assert.match(html, /data-testid="receive-waivers"/u);
  assert.match(html, /跳过小票打印、跳过上挂分配/u);
});

test("ticket print waiver notice preserves its accessible status", () => {
  const html = renderToStaticMarkup(createElement(TicketPrintWaiverNotice));

  assert.match(html, /role="status"/u);
  assert.match(html, /data-testid="ticket-print-waiver"/u);
  assert.match(html, /小票打印已按顾客档案豁免跳过/u);
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

test("enqueueTicketPrint sends only the server-authoritative order_id", async () => {
  const calls: Array<Readonly<{ name: string; body: unknown }>> = [];
  const notices: Array<readonly [string, "success" | "error"]> = [];
  const commandClient = createMockCommandClient(
    async <T = unknown>(name: string, body?: unknown) => {
      calls.push(Object.freeze({ name, body }));
      return Object.freeze({ ok: true as const, data: Object.freeze({}) as T });
    },
  );

  const enqueued = await enqueueTicketPrint(
    commandClient,
    "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    "20260722-0042",
    (message, kind) => notices.push([message, kind]),
  );

  assert.deepEqual(calls, [
    {
      name: "print.ticket.enqueue",
      body: { order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
    },
  ]);
  assert.deepEqual(notices, [["已排队打印 20260722-0042", "success"]]);
  assert.equal(enqueued, true);
});

test("enqueueTicketPrint turns command and transport failures into visible errors", async () => {
  const commandNotices: Array<readonly [string, "success" | "error"]> = [];
  const commandClient = createMockCommandClient(async () =>
    Object.freeze({
      ok: false as const,
      error: Object.freeze({ code: "PRINTER_OFFLINE", message: "打印机离线" }),
    }),
  );
  const commandEnqueued = await enqueueTicketPrint(
    commandClient,
    "order-1",
    "ticket-1",
    (message, kind) => commandNotices.push([message, kind]),
  );
  assert.deepEqual(commandNotices, [["打印机离线", "error"]]);
  assert.equal(commandEnqueued, false);

  const transportNotices: Array<readonly [string, "success" | "error"]> = [];
  const rejectingClient = createMockCommandClient(async () => {
    throw new Error("connection reset");
  });
  let transportEnqueued: boolean | undefined;
  await assert.doesNotReject(async () => {
    transportEnqueued = await enqueueTicketPrint(
      rejectingClient,
      "order-2",
      "ticket-2",
      (message, kind) => transportNotices.push([message, kind]),
    );
  });
  assert.deepEqual(transportNotices, [["无法提交打印任务，请检查本地服务连接", "error"]]);
  assert.equal(transportEnqueued, false);
});

test("receive success keeps a host ticket callback failure post-commit", () => {
  const preview: TicketPreview = Object.freeze({
    lines: Object.freeze(["票单号 T-1"]),
    total_text: "¥1.00",
    paid_text: "¥0.00",
    balance_text: "¥1.00",
  });
  const notices: Array<readonly [string, "success" | "error"]> = [];
  assert.doesNotThrow(() =>
    notifyReceiveSuccess(
      () => {
        throw new Error("host print bridge failed");
      },
      preview,
      "T-1",
      false,
      (message, kind) => notices.push([message, kind]),
    ),
  );
  assert.deepEqual(notices, [["开单成功 T-1；小票联动失败，可从订单详情重试", "error"]]);
});

test("receive success suppresses the host ticket callback when the server freezes a waiver", () => {
  const preview: TicketPreview = Object.freeze({
    lines: Object.freeze(["票单号 T-2"]),
    total_text: "¥1.00",
    paid_text: "¥0.00",
    balance_text: "¥1.00",
  });
  const notices: Array<readonly [string, "success" | "error"]> = [];
  let callbackCalls = 0;

  notifyReceiveSuccess(
    () => {
      callbackCalls += 1;
    },
    preview,
    "T-2",
    true,
    (message, kind) => notices.push([message, kind]),
  );

  assert.equal(callbackCalls, 0);
  assert.deepEqual(notices, [["开单成功 T-2", "success"]]);
});

test("ticket print action uses enqueue exclusively on success and failure", async () => {
  const preview: TicketPreview = Object.freeze({
    lines: Object.freeze(["票单号 T-1"]),
    total_text: "¥1.00",
    paid_text: "¥0.00",
    balance_text: "¥1.00",
  });
  let browserPrints = 0;
  let ticketReadyCalls = 0;
  let enqueueCalls = 0;
  const errors: unknown[] = [];
  const action = createTicketPrintAction(() => undefined);
  const success = await action.run({
    preview,
    onTicketReady: () => {
      ticketReadyCalls += 1;
    },
    onEnqueuePrint: () => {
      enqueueCalls += 1;
      return true;
    },
    browserPrint: () => {
      browserPrints += 1;
    },
    onError: (error) => errors.push(error),
  });
  const failure = await createTicketPrintAction(() => undefined).run({
    preview,
    onTicketReady: () => {
      ticketReadyCalls += 1;
    },
    onEnqueuePrint: async () => {
      enqueueCalls += 1;
      throw new Error("network down");
    },
    browserPrint: () => {
      browserPrints += 1;
    },
    onError: (error) => errors.push(error),
  });

  assert.equal(success, "completed");
  assert.equal(failure, "failed");
  assert.equal(enqueueCalls, 2);
  assert.equal(browserPrints, 0);
  assert.equal(ticketReadyCalls, 0);
  assert.equal(errors.length, 1);
});

test("ticket print action latches a fast successful enqueue for the current order", async () => {
  const preview: TicketPreview = Object.freeze({
    lines: Object.freeze(["票单号 T-FAST"]),
    total_text: "¥1.00",
    paid_text: "¥0.00",
    balance_text: "¥1.00",
  });
  const enqueuedChanges: boolean[] = [];
  let enqueueCalls = 0;
  const action = createTicketPrintAction(
    () => undefined,
    (enqueued) => enqueuedChanges.push(enqueued),
  );
  const options = Object.freeze({
    preview,
    onEnqueuePrint: () => {
      enqueueCalls += 1;
      return true;
    },
    browserPrint: () => assert.fail("browser print must not run"),
    onError: (error: unknown) => assert.fail(String(error)),
  });

  assert.equal(await action.run(options), "completed");
  assert.equal(await action.run(options), "already-enqueued");
  assert.equal(enqueueCalls, 1);
  assert.deepEqual(enqueuedChanges, [true]);
});

test("ticket print action permits retry after a visible enqueue failure", async () => {
  const preview: TicketPreview = Object.freeze({
    lines: Object.freeze(["票单号 T-RETRY"]),
    total_text: "¥1.00",
    paid_text: "¥0.00",
    balance_text: "¥1.00",
  });
  let enqueueCalls = 0;
  const action = createTicketPrintAction(() => undefined);
  const options = Object.freeze({
    preview,
    onEnqueuePrint: () => {
      enqueueCalls += 1;
      return enqueueCalls === 2;
    },
    browserPrint: () => assert.fail("browser print must not run"),
    onError: (error: unknown) => assert.fail(String(error)),
  });

  assert.equal(await action.run(options), "failed");
  assert.equal(await action.run(options), "completed");
  assert.equal(enqueueCalls, 2);
});

test("ticket print action falls back to browser only without an enqueue handler", async () => {
  const preview: TicketPreview = Object.freeze({
    lines: Object.freeze(["票单号 T-2"]),
    total_text: "¥1.00",
    paid_text: "¥0.00",
    balance_text: "¥1.00",
  });
  let browserPrints = 0;
  let readyPreview: TicketPreview | null = null;
  const result = await createTicketPrintAction(() => undefined).run({
    preview,
    onTicketReady: (value) => {
      readyPreview = value;
    },
    browserPrint: () => {
      browserPrints += 1;
    },
    onError: (error) => assert.fail(String(error)),
  });

  assert.equal(result, "completed");
  assert.equal(browserPrints, 1);
  assert.equal(readyPreview, preview);
});

test("ticket print action rejects duplicate clicks until the first enqueue settles", async () => {
  const preview: TicketPreview = Object.freeze({
    lines: Object.freeze(["票单号 T-3"]),
    total_text: "¥1.00",
    paid_text: "¥0.00",
    balance_text: "¥1.00",
  });
  const busyChanges: boolean[] = [];
  let enqueueCalls = 0;
  let release: () => void = () => assert.fail("release was not initialized");
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const action = createTicketPrintAction((busy) => busyChanges.push(busy));
  const options = Object.freeze({
    preview,
    onEnqueuePrint: async () => {
      enqueueCalls += 1;
      await pending;
      return true;
    },
    browserPrint: () => assert.fail("browser print must not run"),
    onError: (error: unknown) => assert.fail(String(error)),
  });

  const first = action.run(options);
  const duplicate = await action.run(options);
  assert.equal(duplicate, "busy");
  assert.equal(enqueueCalls, 1);
  assert.deepEqual(busyChanges, [true]);

  release();
  assert.equal(await first, "completed");
  assert.deepEqual(busyChanges, [true, false]);
});
