import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { CustomerPortalLogin } from "./CustomerPortalLogin.js";
import { CustomerPortalOrders } from "./CustomerPortalOrders.js";

const ORDER = "11111111-1111-4111-8111-111111111111";
const GARMENT = "22222222-2222-4222-8222-222222222222";
const summary = Object.freeze({
  order_id: ORDER,
  ticket_no: "20260813-0001",
  status: "open" as const,
  payable_cents: 2_000,
  paid_cents: 1_000,
  balance_cents: 1_000,
  garment_count: 1,
  created_at: "2026-08-13T01:00:00.000Z",
  updated_at: "2026-08-13T01:10:00.000Z",
});
const detail = Object.freeze({
  order: Object.freeze({ order: summary, lines: Object.freeze([]) }),
  receipt: Object.freeze({
    receipt: Object.freeze({
      order_id: ORDER,
      ticket_no: summary.ticket_no,
      business_date: "2026-08-13",
      original_cents: 2_000,
      discount_cents: 0,
      addon_cents: 0,
      urgent_cents: 0,
      freight_cents: 0,
      payable_cents: 2_000,
      paid_cents: 1_000,
      balance_cents: 1_000,
      created_at: summary.created_at,
      lines: Object.freeze([]),
      payments: Object.freeze([]),
    }),
  }),
  garments: Object.freeze({
    garments: Object.freeze([
      Object.freeze({
        garment_id: GARMENT,
        order_id: ORDER,
        seq: 1,
        service_code: "wash",
        category_code: "shirt",
        color: null,
        brand: null,
        status: "washing" as const,
      }),
    ]),
  }),
});

test("customer portal login is a mobile-friendly semantic form", () => {
  const markup = renderToStaticMarkup(
    <CustomerPortalLogin busy={false} error={null} onLogin={async () => undefined} />,
  );
  assert.match(markup, /<main[^>]+ld-customer-login/u);
  assert.match(markup, /inputMode="tel"/u);
  assert.match(markup, /autoComplete="tel"/u);
  assert.match(markup, /验证失败不会说明哪一项信息不正确/u);
});

test("customer portal desktop view exposes receipt and authoritative piece progress controls", () => {
  const markup = renderToStaticMarkup(
    <CustomerPortalOrders
      orders={[summary]}
      selectedOrderId={ORDER}
      detail={detail}
      progress={{}}
      busy={false}
      error={null}
      onSelect={() => undefined}
      onProgress={() => undefined}
      onRefresh={() => undefined}
      onLogout={() => undefined}
    />,
  );
  assert.match(markup, /我的订单/u);
  assert.match(markup, /票据/u);
  assert.match(markup, /件级洗护进度/u);
  assert.match(markup, /查看节点/u);
  assert.doesNotMatch(markup, /phone|note|staff|barcode|reason/iu);
});

test("customer portal stylesheet switches from one-column mobile to bounded desktop grid", async () => {
  const css = await readFile(
    new URL("../../src/styles/customer-portal.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.ld-customer-layout\s*\{[\s\S]*display:\s*grid/iu);
  assert.match(css, /@media \(min-width: 900px\)/u);
  assert.match(css, /grid-template-columns:\s*minmax\(280px/iu);
  assert.match(css, /min-height:\s*44px/iu);
});
