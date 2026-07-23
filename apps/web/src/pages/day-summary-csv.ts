/**
 * Pure day-summary CSV formatting + browser download helper.
 * Integer fen columns only — never convert to yuan floats.
 */

import type { DaySummaryView } from "./StatsPage.js";

/** Stable header order matching DaySummaryView fields. */
export const DAY_SUMMARY_CSV_HEADERS = Object.freeze([
  "business_date",
  "order_count",
  "garment_count",
  "payable_cents",
  "paid_cents",
  "balance_cents",
  "payment_cents",
  "picked_garment_count",
] as const);

/**
 * Format one day summary as CSV (header + one data row).
 * Money stays integer fen; no float conversion.
 */
export function formatDaySummaryCsv(summary: DaySummaryView): string {
  const header = DAY_SUMMARY_CSV_HEADERS.join(",");
  const row = [
    summary.business_date,
    String(summary.order_count),
    String(summary.garment_count),
    String(summary.payable_cents),
    String(summary.paid_cents),
    String(summary.balance_cents),
    String(summary.payment_cents),
    String(summary.picked_garment_count),
  ].join(",");
  return `${header}\n${row}\n`;
}

/** Filename for a business day export: stats-YYYY-MM-DD.csv */
export function daySummaryCsvFilename(businessDate: string): string {
  return `stats-${businessDate}.csv`;
}

/**
 * Trigger a browser download of the day-summary CSV.
 * No-op under SSR / non-DOM environments.
 */
export function downloadDaySummaryCsv(summary: DaySummaryView): void {
  if (typeof document === "undefined" || typeof URL === "undefined") {
    return;
  }
  if (typeof Blob === "undefined") {
    return;
  }

  const csv = formatDaySummaryCsv(summary);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = daySummaryCsvFilename(summary.business_date);
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
