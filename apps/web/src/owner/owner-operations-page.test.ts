import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { OwnerDrilldownView } from "./OwnerDrilldownPanel.js";
import type {
  OwnerPickupDrilldown,
  OwnerPortfolioData,
  OwnerStagnantDrilldown,
} from "./owner-operations-model.js";
import { OwnerPortfolioView } from "./OwnerPortfolioPanel.js";

const pickup: OwnerPickupDrilldown = Object.freeze({
  kind: "today_pickups",
  business_date: "2026-08-07",
  generated_at: "2026-08-07T05:00:00.000Z",
  total_row_count: 1,
  truncated: false,
  totals: Object.freeze({ picked_up_garment_count: 2, picked_up_order_count: 1 }),
  rows: Object.freeze([
    Object.freeze({
      ticket_no: "20260807-0001",
      picked_at: "2026-08-07T04:30:00.000Z",
      garment_count: 2,
    }),
  ]),
});

const stagnant: OwnerStagnantDrilldown = Object.freeze({
  kind: "stagnant_garments",
  business_date: "2026-08-07",
  generated_at: "2026-08-07T05:00:00.000Z",
  total_row_count: 51,
  truncated: true,
  overdue_min_age_days: 30,
  totals: Object.freeze({ overdue_garment_count: 55, overdue_order_count: 51 }),
  rows: Object.freeze(
    Array.from({ length: 50 }, (_, index) =>
      Object.freeze({
        ticket_no: `20260601-${String(index).padStart(4, "0")}`,
        received_at: "2026-06-01T02:00:00.000Z",
        age_days: 67,
        garment_count: index < 5 ? 2 : 1,
        balance_cents: 0,
      }),
    ),
  ),
});

const portfolio: OwnerPortfolioData = Object.freeze({
  generated_at: "2026-08-07T05:00:00.000Z",
  returned_store_count: 1,
  truncated: false,
  totals: Object.freeze({
    performance_income_cents: 12_300,
    real_income_cents: 10_000,
    picked_up_garment_count: 7,
    new_receivable_cents: 4_500,
    new_receivable_order_count: 2,
    overdue_garment_count: 9,
    overdue_order_count: 4,
  }),
  stores: Object.freeze([
    Object.freeze({
      store_code: "main",
      store_name: "主店",
      timezone: "Asia/Shanghai",
      business_date: "2026-08-07",
      performance_income_cents: 12_300,
      real_income_cents: 10_000,
      picked_up_garment_count: 7,
      new_receivable_cents: 4_500,
      new_receivable_order_count: 2,
      overdue_garment_count: 9,
      overdue_order_count: 4,
    }),
  ]),
});

const noop = () => undefined;

test("OwnerDrilldownView renders minimized pickup rows and explicit states", () => {
  const ready = renderToStaticMarkup(
    createElement(OwnerDrilldownView, {
      kind: "today_pickups",
      data: pickup,
      loading: false,
      error: null,
      onRetry: noop,
      onClose: noop,
    }),
  );
  assert.match(ready, /今日取衣明细/u);
  assert.match(ready, /20260807-0001/u);
  assert.match(ready, /共 1 单 · 2 件/u);
  assert.doesNotMatch(ready, /顾客|手机号|条码|架位/u);

  const failed = renderToStaticMarkup(
    createElement(OwnerDrilldownView, {
      kind: "today_pickups",
      data: null,
      loading: false,
      error: "本地服务暂时不可用",
      onRetry: noop,
      onClose: noop,
    }),
  );
  assert.match(failed, /role="alert"/u);
  assert.match(failed, /重新加载/u);
});

test("OwnerDrilldownView explains bounded rows without truncating totals", () => {
  const html = renderToStaticMarkup(
    createElement(OwnerDrilldownView, {
      kind: "stagnant_garments",
      data: stagnant,
      loading: false,
      error: null,
      onRetry: noop,
      onClose: noop,
    }),
  );
  assert.match(html, /共 51 单 · 55 件/u);
  assert.match(html, /只展示前 50 单；上方汇总仍是完整口径/u);
});

test("OwnerDrilldownView never renders stale kind or failed authority data", () => {
  for (const input of [
    { kind: "new_receivables" as const, error: null },
    { kind: "today_pickups" as const, error: "没有查看权限" },
  ]) {
    const html = renderToStaticMarkup(
      createElement(OwnerDrilldownView, {
        kind: input.kind,
        data: pickup,
        loading: false,
        error: input.error,
        onRetry: noop,
        onClose: noop,
      }),
    );
    assert.doesNotMatch(html, /20260807-0001|共 1 单 · 2 件/u);
  }
});

test("OwnerPortfolioView renders only store-safe comparison fields and totals", () => {
  const html = renderToStaticMarkup(
    createElement(OwnerPortfolioView, {
      data: portfolio,
      loading: false,
      error: null,
      onRefresh: noop,
    }),
  );
  assert.match(html, /逐店重新校验管理员权限/u);
  assert.match(html, /主店/u);
  assert.match(html, /main · Asia\/Shanghai/u);
  assert.match(html, /data-fen="12300"/u);
  assert.match(html, /data-fen="4500"/u);
  assert.doesNotMatch(html, /store_id|customer|手机号/u);
});

test("OwnerPortfolioView renders loading, empty and clears data on refresh errors", () => {
  const loading = renderToStaticMarkup(
    createElement(OwnerPortfolioView, {
      data: null,
      loading: true,
      error: null,
      onRefresh: noop,
    }),
  );
  assert.match(loading, /role="status"/u);

  const empty = renderToStaticMarkup(
    createElement(OwnerPortfolioView, {
      data: {
        ...portfolio,
        returned_store_count: 0,
        stores: [],
        totals: {
          performance_income_cents: 0,
          real_income_cents: 0,
          picked_up_garment_count: 0,
          new_receivable_cents: 0,
          new_receivable_order_count: 0,
          overdue_garment_count: 0,
          overdue_order_count: 0,
        },
      },
      loading: false,
      error: null,
      onRefresh: noop,
    }),
  );
  assert.match(empty, /没有其他授权门店/u);

  const stale = renderToStaticMarkup(
    createElement(OwnerPortfolioView, {
      data: portfolio,
      loading: false,
      error: "查询失败",
      onRefresh: noop,
    }),
  );
  assert.match(stale, /查询失败/u);
  assert.doesNotMatch(stale, /主店|data-fen="12300"/u);
});
