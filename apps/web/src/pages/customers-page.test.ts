import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";
import { FULL_STORE_FEATURES } from "../auth/permissions.js";
import type { SessionView } from "../auth/types.js";
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

function memberSession(enabled: boolean): SessionView {
  return Object.freeze({
    session: Object.freeze({
      session_id: "d1111111-1111-4111-8111-111111111111",
      session_version: 1,
      org_id: "d2222222-2222-4222-8222-222222222222",
      store_id: "d3333333-3333-4333-8333-333333333333",
      staff_id: "d4444444-4444-4444-8444-444444444444",
      device_id: "d5555555-5555-4555-8555-555555555555",
      permission_version: 1,
    }),
    role: "admin",
    features: Object.freeze({ ...FULL_STORE_FEATURES, member_enabled: enabled }),
    display: Object.freeze({
      store_name: "本地门店",
      staff_name: "店长",
      org_code: "ORG",
      store_code: "S1",
    }),
  });
}

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

test("member-disabled sessions neither mount nor render the account panel", () => {
  const render = (enabled: boolean) =>
    renderToStaticMarkup(
      createElement(
        ToastProvider,
        null,
        createElement(CustomersPage, {
          queryClient: createMockQueryClient(),
          commandClient: createMockCommandClient(),
          autoLoad: false,
          initialSelected: SAMPLE_CUSTOMER,
          initialOrders: Object.freeze([]),
          session: memberSession(enabled),
        }),
      ),
    );

  assert.doesNotMatch(render(false), /aria-label="会员储值"/);
  assert.match(render(true), /aria-label="会员储值"/);
});

test("delivery feature preserves cancellation access while gating new appointment work", () => {
  const render = (deliveryEnabled: boolean) => {
    const base = memberSession(false);
    const session: SessionView = Object.freeze({
      ...base,
      features: Object.freeze({ ...base.features, delivery_enabled: deliveryEnabled }),
    });
    return renderToStaticMarkup(
      createElement(
        ToastProvider,
        null,
        createElement(CustomersPage, {
          queryClient: createMockQueryClient(),
          commandClient: createMockCommandClient(),
          autoLoad: false,
          initialSelected: SAMPLE_CUSTOMER,
          initialOrders: Object.freeze([]),
          session,
        }),
      ),
    );
  };

  assert.match(render(false), /data-testid="delivery-appointment-panel"/u);
  assert.match(render(false), /门店取送功能已关闭/u);
  assert.match(render(true), /data-testid="delivery-appointment-panel"/u);
  assert.match(render(true), /预约、改期与取消/u);
});
