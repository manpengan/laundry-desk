import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { ToastProvider } from "@laundry/ui";
import { createMockCommandClient } from "../commands/command-client.js";
import { createMockQueryClient } from "../commands/query-client.js";
import { daySummaryCsvFilename, formatDaySummaryCsv } from "./day-summary-csv.js";
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

test("formatDaySummaryCsv emits header + integer fen columns (no float)", () => {
  const csv = formatDaySummaryCsv(SAMPLE);
  const lines = csv.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(
    lines[0],
    "business_date,order_count,garment_count,payable_cents,paid_cents,balance_cents,payment_cents,picked_garment_count",
  );
  assert.equal(lines[1], "2026-07-22,3,5,12000,4000,8000,2000,1");
  assert.doesNotMatch(csv, /\./u);
  assert.equal(daySummaryCsvFilename(SAMPLE.business_date), "stats-2026-07-22.csv");
});

test("formatDaySummaryCsv keeps zero and large fen as integers", () => {
  const zero = formatDaySummaryCsv(
    Object.freeze({
      business_date: "2026-01-01",
      order_count: 0,
      garment_count: 0,
      payable_cents: 0,
      paid_cents: 0,
      balance_cents: 0,
      payment_cents: 0,
      picked_garment_count: 0,
    }),
  );
  assert.match(zero, /2026-01-01,0,0,0,0,0,0,0/u);
  assert.doesNotMatch(zero, /0\.0/u);

  const large = formatDaySummaryCsv(
    Object.freeze({
      ...SAMPLE,
      payable_cents: 1_234_567,
      paid_cents: 999,
    }),
  );
  assert.match(large, /1234567/u);
  assert.match(large, /,999,/u);
  assert.doesNotMatch(large, /12345\.67|9\.99/u);
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
  assert.match(html, /导出 CSV/);
  assert.match(html, /data-testid="stats-date-input"/);
  assert.match(html, /data-testid="stats-load-btn"/);
  assert.match(html, /data-testid="stats-export-csv-btn"/);
  // useEffect does not run under SSR — cards only after client load
  assert.doesNotMatch(html, /data-testid="stats-summary"/);
  // shift panel only when commandClient provided
  assert.doesNotMatch(html, /data-testid="shift-close-panel"/);
});

test("StatsPage SSR with commandClient shows shift close panel", () => {
  const queryClient = createMockQueryClient();
  const commandClient = createMockCommandClient();
  const html = renderToStaticMarkup(
    createElement(
      ToastProvider,
      null,
      createElement(StatsPage, {
        queryClient,
        commandClient,
        defaultDate: "2026-07-22",
        autoLoad: false,
      }),
    ),
  );
  assert.match(html, /data-testid="shift-close-panel"/);
  assert.match(html, /交班确认/);
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
