import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";
import { createMockCommandClient } from "../commands/command-client.js";
import { createMockQueryClient } from "../commands/query-client.js";
import {
  CustomersPage,
  parseCustomerRows,
  unwrapQueryResult,
  type CustomerRowView,
} from "./CustomersPage.js";

const SAMPLE_ROWS: readonly CustomerRowView[] = Object.freeze([
  Object.freeze({
    customer_id: "c1111111-1111-4111-8111-111111111111",
    phone: "13800000111",
    name: "张三",
    note: null,
    updated_at: 1_700_000_100,
  }),
]);

test("parseCustomerRows accepts documented result shape", () => {
  assert.deepEqual(parseCustomerRows({ customers: SAMPLE_ROWS }), SAMPLE_ROWS);
  assert.equal(parseCustomerRows({ customers: [{ phone: "x" }] }), null);
  assert.equal(parseCustomerRows(null), null);
});

test("unwrapQueryResult peels bus envelope", () => {
  assert.deepEqual(
    unwrapQueryResult({ execution: "executed", result: { customers: SAMPLE_ROWS } }),
    { customers: SAMPLE_ROWS },
  );
  assert.deepEqual(unwrapQueryResult({ customers: SAMPLE_ROWS }), { customers: SAMPLE_ROWS });
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
          result: Object.freeze({ customers: SAMPLE_ROWS }),
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
});
