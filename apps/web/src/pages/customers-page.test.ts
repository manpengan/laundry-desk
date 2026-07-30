import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";
import { createMockCommandClient } from "../commands/command-client.js";
import { createMockQueryClient } from "../commands/query-client.js";
import {
  CustomersPage,
  formatCustomerUpdatedAt,
  parseCustomerRows,
  unwrapQueryResult,
  type CustomerRowView,
} from "./CustomersPage.js";
import type { OrderListRowView } from "./OrdersList.js";
import type { PrintJobView } from "../shell/print-jobs.js";

const SAMPLE_CUSTOMER: CustomerRowView = Object.freeze({
  customer_id: "c1111111-1111-4111-8111-111111111111",
  phone: "13800000111",
  name: "张三",
  note: "常客",
  updated_at: 1_700_000_100,
});

const SAMPLE_LIST_ROWS = Object.freeze([
  Object.freeze({
    customer_id: SAMPLE_CUSTOMER.customer_id,
    phone_masked: "138****0111",
    name: SAMPLE_CUSTOMER.name,
    updated_at: SAMPLE_CUSTOMER.updated_at,
  }),
]);
const PARSED_LIST_ROWS: readonly CustomerRowView[] = Object.freeze([
  Object.freeze({ ...SAMPLE_CUSTOMER, phone: "138****0111", note: null }),
]);

const SAMPLE_ORDER: OrderListRowView = Object.freeze({
  order_id: "a1111111-1111-4111-8111-111111111111",
  ticket_no: "20240722-0001",
  status: "open",
  customer_phone: "13800000111",
  customer_name: "张三",
  payable_cents: 3000,
  paid_cents: 500,
  balance_cents: 2500,
  created_at: 1_721_606_400,
  garment_count: 2,
});
const SAMPLE_PRINT: PrintJobView = Object.freeze({
  job_id: "b1111111-1111-4111-8111-111111111111",
  kind: "xp58",
  status: "done",
  order_id: SAMPLE_ORDER.order_id,
  ticket_no: SAMPLE_ORDER.ticket_no ?? "挂单",
  created_at: 1_721_606_400,
  updated_at: 1_721_606_410,
});

test("parseCustomerRows accepts documented result shape", () => {
  assert.deepEqual(parseCustomerRows({ customers: SAMPLE_LIST_ROWS }), PARSED_LIST_ROWS);
  assert.equal(parseCustomerRows({ customers: [{ phone: "x" }] }), null);
  assert.equal(parseCustomerRows(null), null);
});

test("unwrapQueryResult peels bus envelope", () => {
  assert.deepEqual(
    unwrapQueryResult({ execution: "executed", result: { customers: SAMPLE_LIST_ROWS } }),
    { customers: SAMPLE_LIST_ROWS },
  );
  assert.deepEqual(unwrapQueryResult({ customers: SAMPLE_LIST_ROWS }), {
    customers: SAMPLE_LIST_ROWS,
  });
});

test("formatCustomerUpdatedAt formats local compact timestamp", () => {
  const text = formatCustomerUpdatedAt(1_700_000_100);
  assert.match(text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/u);
});

test("CustomersPage SSR shell shows search + upsert controls", () => {
  const queryClient = createMockQueryClient();
  const commandClient = createMockCommandClient();
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(CustomersPage, {
        queryClient,
        commandClient,
        autoLoad: false,
      }),
    ),
  );

  assert.match(html, /客户/);
  assert.match(html, /搜索/);
  assert.match(html, /保存客户/);
  assert.match(html, /data-testid="customers-search-input"/);
  assert.match(html, /data-testid="customers-search-btn"/);
  assert.match(html, /data-testid="customers-phone-input"/);
  assert.match(html, /data-testid="customers-upsert-btn"/);
  assert.match(html, /data-testid="customers-list"/);
  assert.doesNotMatch(html, /#ff0000/i);
  assert.doesNotMatch(html, /rgb\(/i);
});

test("CustomersPage SSR with mock query still renders empty list under SSR", () => {
  const queryClient = createMockQueryClient(async <T = unknown>(name: string) => {
    if (name === "customer.search") {
      return Object.freeze({
        ok: true as const,
        data: Object.freeze({
          execution: "executed",
          result: Object.freeze({ customers: SAMPLE_LIST_ROWS }),
        }) as T,
      });
    }
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({ code: "RESOURCE_UNAVAILABLE", message: "未知查询" }),
    });
  });
  const commandClient = createMockCommandClient();

  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(CustomersPage, {
        queryClient,
        commandClient,
        autoLoad: false,
      }),
    ),
  );
  assert.match(html, /组织级客户档案/);
  // useEffect does not run under SSR
  assert.match(html, /暂无匹配客户/);
  assert.doesNotMatch(html, /data-testid="customer-detail"/);
});

test("CustomersPage SSR detail shell shows profile + history orders", () => {
  const queryClient = createMockQueryClient();
  const commandClient = createMockCommandClient();
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(CustomersPage, {
        queryClient,
        commandClient,
        autoLoad: false,
        initialSelected: SAMPLE_CUSTOMER,
        initialOrders: Object.freeze([SAMPLE_ORDER]),
        initialPrintJobs: Object.freeze([SAMPLE_PRINT]),
        onOpenPickup: () => undefined,
      }),
    ),
  );

  assert.match(html, /data-testid="customer-detail"/);
  assert.match(html, /data-testid="customer-detail-profile"/);
  assert.match(html, /data-testid="customer-detail-orders"/);
  assert.match(html, /data-testid="customer-detail-updated-at"/);
  assert.match(html, /data-testid="customer-detail-close"/);
  assert.match(html, /data-testid="customer-detail-order-btn"/);
  assert.match(html, /13800000111/);
  assert.match(html, /张三/);
  assert.match(html, /常客/);
  assert.match(html, /历史订单/);
  assert.match(html, /20240722-0001/);
  assert.match(html, /余额/);
  assert.match(html, /打印：已完成/);
  assert.match(html, /去取衣/);
  assert.doesNotMatch(html, /#ff0000/i);
  assert.doesNotMatch(html, /rgb\(/i);
});

test("CustomersPage SSR detail empty history copy", () => {
  const queryClient = createMockQueryClient();
  const commandClient = createMockCommandClient();
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(CustomersPage, {
        queryClient,
        commandClient,
        autoLoad: false,
        initialSelected: SAMPLE_CUSTOMER,
        initialOrders: Object.freeze([]),
      }),
    ),
  );
  assert.match(html, /data-testid="customer-detail"/);
  assert.match(html, /暂无历史订单/);
});
