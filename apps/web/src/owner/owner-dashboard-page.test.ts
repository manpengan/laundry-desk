import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { OwnerDashboardView, type OwnerDashboardViewProps } from "./OwnerDashboardPage.js";
import { parseOwnerDashboard, type OwnerDashboardData } from "./owner-dashboard-model.js";

function sampleDashboard(): OwnerDashboardData {
  const end = new Date("2026-08-07T12:00:00.000Z");
  const trend = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - (29 - index));
    return {
      business_date: date.toISOString().slice(0, 10),
      performance_income_cents: index === 29 ? 12_300 : index * 100,
      real_income_cents: index === 29 ? 10_000 : index * 80,
    };
  });
  const parsed = parseOwnerDashboard({
    business_date: "2026-08-07",
    generated_at: "2026-08-07T05:00:00.000Z",
    overdue_min_age_days: 30,
    today: {
      performance_income_cents: 12_300,
      real_income_cents: 10_000,
      picked_up_garment_count: 7,
      new_receivable_cents: 4_500,
      new_receivable_order_count: 2,
      overdue_garment_count: 9,
      overdue_order_count: 4,
    },
    trend,
  });
  assert.notEqual(parsed, null);
  if (parsed === null) throw new Error("sample dashboard must parse");
  return parsed;
}

function render(overrides: Partial<OwnerDashboardViewProps> = {}): string {
  return renderToStaticMarkup(
    createElement(OwnerDashboardView, {
      dashboard: null,
      loading: false,
      error: null,
      trendDays: 7,
      onTrendDaysChange: () => undefined,
      onRefresh: () => undefined,
      ...overrides,
    }),
  );
}

test("OwnerDashboardView renders explicit loading, empty, and error states", () => {
  const loading = render({ loading: true });
  assert.match(loading, /data-state="loading"/u);
  assert.match(loading, /正在读取经营数据/u);

  const empty = render();
  assert.match(empty, /data-state="empty"/u);
  assert.match(empty, /暂无经营数据/u);
  assert.match(empty, /立即刷新/u);

  const failed = render({ error: "本地服务暂时不可用" });
  assert.match(failed, /data-state="error"/u);
  assert.match(failed, /本地服务暂时不可用/u);
  assert.match(failed, /重新加载/u);

  const revoked = render({ dashboard: sampleDashboard(), error: "没有查看权限" });
  assert.match(revoked, /data-state="error"/u);
  assert.match(revoked, /没有查看权限/u);
  assert.doesNotMatch(revoked, /data-fen="12300"|owner-trend-row/u);
});

test("OwnerDashboardView renders the four cards and exposes only three bounded drilldowns", () => {
  const html = render({ dashboard: sampleDashboard(), onOpenDrilldown: () => undefined });

  assert.match(html, /data-state="ready"/u);
  assert.match(html, /今日营业额/u);
  assert.match(html, /业绩看洗护消费，实收看现金流/u);
  assert.match(html, /data-fen="12300"/u);
  assert.match(html, /实收/u);
  assert.match(html, /data-fen="10000"/u);
  assert.match(html, /今日取衣件数/u);
  assert.match(html, />7 件</u);
  assert.match(html, /新增欠款/u);
  assert.match(html, /data-fen="4500"/u);
  assert.match(html, /2 单/u);
  assert.match(html, /滞留件/u);
  assert.match(html, />9 件</u);
  assert.match(html, /4 单 · 满 30 天/u);
  assert.match(html, /刷新数据/u);
  assert.match(html, /查看取衣明细/u);
  assert.match(html, /查看欠款明细/u);
  assert.match(html, /查看滞留明细/u);
  assert.doesNotMatch(html, /查看营业额明细/u);
});

test("OwnerDashboardView switches 7 and 30 day trends by client-side slicing", () => {
  const dashboard = sampleDashboard();
  const seven = render({ dashboard, trendDays: 7 });
  const thirty = render({ dashboard, trendDays: 30 });

  assert.equal((seven.match(/data-testid="owner-trend-row"/gu) ?? []).length, 7);
  assert.equal((thirty.match(/data-testid="owner-trend-row"/gu) ?? []).length, 30);
  assert.match(seven, /aria-pressed="true"[^>]*>近 7 日/u);
  assert.match(thirty, /aria-pressed="true"[^>]*>近 30 日/u);
});
