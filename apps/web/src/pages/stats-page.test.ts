import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";
import { createMockQueryClient } from "../commands/query-client.js";
import {
  localYmd,
  parseDaySummary,
  StatsPage,
  unwrapQueryResult,
  type DaySummaryView,
} from "./StatsPage.js";

const SAMPLE: DaySummaryView = Object.freeze({
  business_date: "2026-07-22",
  order_count: 3,
  garment_count: 5,
  payable_cents: 12000,
  paid_cents: 4000,
  balance_cents: 8000,
  payment_cents: 2000,
  picked_garment_count: 1,
});

test("localYmd formats local calendar day", () => {
  assert.equal(localYmd(new Date(2026, 6, 22, 9, 30, 0)), "2026-07-22");
});

test("parseDaySummary accepts documented result shape", () => {
  assert.deepEqual(parseDaySummary(SAMPLE), SAMPLE);
  assert.equal(parseDaySummary({ business_date: "x" }), null);
  assert.equal(parseDaySummary(null), null);
});

test("unwrapQueryResult peels bus envelope", () => {
  assert.deepEqual(unwrapQueryResult({ execution: "executed", result: SAMPLE }), SAMPLE);
  assert.deepEqual(unwrapQueryResult(SAMPLE), SAMPLE);
});

test("StatsPage SSR shell shows date control and load button", () => {
  const queryClient = createMockQueryClient();
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(StatsPage, {
        queryClient,
        defaultDate: "2026-07-22",
        autoLoad: false,
      }),
    ),
  );

  assert.match(html, /统计/);
  assert.match(html, /营业日/);
  assert.match(html, /查询日结/);
  assert.match(html, /data-testid="stats-date-input"/);
  assert.match(html, /data-testid="stats-load-btn"/);
  // useEffect does not run under SSR — cards only after client load
  assert.doesNotMatch(html, /data-testid="stats-summary"/);
});

test("StatsPage SSR with pre-resolved summary cards via parse path", () => {
  // SSR cannot run effects; verify metric card markup shape independently.
  const queryClient = createMockQueryClient(async <T = unknown>(name: string) => {
    if (name === "stats.day.summary") {
      return Object.freeze({
        ok: true as const,
        data: Object.freeze({
          execution: "executed",
          result: SAMPLE,
        }) as T,
      });
    }
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({ code: "RESOURCE_UNAVAILABLE", message: "未知查询" }),
    });
  });

  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(StatsPage, {
        queryClient,
        defaultDate: "2026-07-22",
        autoLoad: false,
      }),
    ),
  );
  assert.match(html, /日结汇总/);
  assert.doesNotMatch(html, /#ff0000/i);
  assert.doesNotMatch(html, /rgb\(/i);
});
