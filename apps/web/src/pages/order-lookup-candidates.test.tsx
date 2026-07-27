import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";

import { OrderLookupCandidates, parseOrderLookupRows } from "./OrderLookupCandidates.js";

const payload = Object.freeze({
  orders: [
    {
      order_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      ticket_no: "20260722-0001",
      pickup_code: "P202607220001",
      status: "open",
      customer_phone: "13800000111",
      customer_name: "张三",
      payable_cents: 3000,
      paid_cents: 500,
      balance_cents: 2500,
      created_at: 1_700_000_000,
      garment_count: 2,
      matched_by: "customer_name",
    },
    {
      order_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ticket_no: "20260722-0002",
      pickup_code: "P202607220002",
      status: "open",
      customer_phone: "13800000111",
      customer_name: "张三",
      payable_cents: 2000,
      paid_cents: 0,
      balance_cents: 2000,
      created_at: 1_700_000_100,
      garment_count: 1,
      matched_by: "customer_name",
    },
  ],
});

test("parseOrderLookupRows keeps server match metadata and candidate display requires an explicit choice", () => {
  const rows = parseOrderLookupRows(payload);
  assert.ok(rows);
  assert.equal(rows[0]?.matched_by, "customer_name");
  assert.equal(rows[0]?.pickup_code, "P202607220001");
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(OrderLookupCandidates, {
        orders: rows,
        disabled: false,
        onSelect: () => undefined,
      }),
    ),
  );
  assert.match(html, /找到多张订单，请选择/);
  assert.match(html, /客户姓名/);
  assert.match(html, /P202607220002/);
});

test("parseOrderLookupRows rejects an untrusted match kind", () => {
  assert.equal(
    parseOrderLookupRows({ orders: [{ ...payload.orders[0], matched_by: "unknown" }] }),
    null,
  );
});
