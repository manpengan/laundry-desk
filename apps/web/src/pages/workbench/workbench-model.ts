/** Pure view models for the counter workbench (ADR-100): no I/O, no React. */

import type { FulfillmentRowView } from "../fulfillment-model.js";
import { knownCategoryLabel } from "../garment-labels.js";
import { serviceLabel } from "../catalog-services.js";

export type WorkbenchRole = "owner" | "clerk";
export type Tone = "late" | "warn" | "plain" | "ok";

const DAY_MS = 86_400_000;
const WEEKDAYS = Object.freeze(["周日", "周一", "周二", "周三", "周四", "周五", "周六"]);
const YMD = /^(\d{4})-(\d{2})-(\d{2})$/u;

/** Store administrators see money; counter staff see the day's work. */
export function workbenchRole(role: "admin" | "staff"): WorkbenchRole {
  return role === "admin" ? "owner" : "clerk";
}

/** Counter greeting for a local hour. */
export function greetingFor(hour: number): string {
  if (hour >= 5 && hour < 11) return "早上好";
  if (hour >= 11 && hour < 13) return "中午好";
  if (hour >= 13 && hour < 18) return "下午好";
  return "晚上好";
}

function parseYmd(ymd: string): Date | null {
  const match = YMD.exec(ymd);
  if (match === null) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === ymd ? date : null;
}

/** "2026-10-18" → "10月18日 周六"; calendar math stays in UTC so the label never drifts. */
export function businessDayLabel(ymd: string): string | null {
  const date = parseYmd(ymd);
  if (date === null) return null;
  return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日 ${WEEKDAYS[date.getUTCDay()]}`;
}

/** Business day `days` away from `ymd` (negative = earlier). */
export function shiftBusinessDay(ymd: string, days: number): string | null {
  const date = parseYmd(ymd);
  if (date === null) return null;
  return new Date(date.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** Order timestamps are epoch milliseconds; tolerate epoch seconds. */
export function toMillis(value: number): number {
  return value < 1e12 ? value * 1000 : value;
}

/** Whole local calendar days between two instants (0 = same day). */
export function calendarDaysBetween(fromMs: number, toMs: number): number {
  const from = new Date(fromMs);
  const to = new Date(toMs);
  const start = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const end = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.max(0, Math.round((end - start) / DAY_MS));
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Short receipt label: today shows the time, older orders the date. */
export function receivedLabel(createdAt: number, nowMs: number): string {
  const ms = toMillis(createdAt);
  const date = new Date(ms);
  if (calendarDaysBetween(ms, nowMs) === 0) {
    return `今天 ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }
  return `${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} 收件`;
}

/** How long an open order has waited, with the tone the counter should read it in. */
export function waitView(
  createdAt: number,
  nowMs: number,
): Readonly<{ label: string; tone: Tone }> {
  const days = calendarDaysBetween(toMillis(createdAt), nowMs);
  if (days === 0) return Object.freeze({ label: "今天收", tone: "ok" });
  if (days >= 30) return Object.freeze({ label: `已 ${days} 天`, tone: "late" });
  return Object.freeze({ label: `已 ${days} 天`, tone: days >= 7 ? "warn" : "plain" });
}

/** "1 小时 48 分后" for a coming window; "进行中" inside it; "已结束" after it. */
export function windowLabel(nowMs: number, startMs: number, endMs: number): string {
  if (nowMs >= endMs) return "已结束";
  if (nowMs >= startMs) return "进行中";
  const minutes = Math.ceil((startMs - nowMs) / 60_000);
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} 小时后` : `${hours} 小时 ${rest} 分后`;
}

/** "17:30–18:00" in local time. */
export function clockRange(startMs: number, endMs: number): string {
  const format = (ms: number) => {
    const date = new Date(ms);
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  };
  return `${format(startMs)}–${format(endMs)}`;
}

/** fraction is null when there is no baseline to measure against. */
export type ProgressView = Readonly<{ fraction: number | null; percent: number; label: string }>;

/** Today's figure against yesterday's whole day (mid-day comparisons need a full day). */
export function versusYesterday(today: number, yesterday: number | null): ProgressView | null {
  if (yesterday === null) return null;
  if (yesterday <= 0) {
    return Object.freeze({ fraction: null, percent: 0, label: "昨日全天无记录" });
  }
  const percent = Math.round((today / yesterday) * 100);
  return Object.freeze({
    fraction: Math.min(1, Math.max(0, today / yesterday)),
    percent,
    label: `已达昨日全天 ${percent}%`,
  });
}

export type HourBucket = Readonly<{
  hour: number;
  today: number;
  yesterday: number;
  state: "past" | "now" | "future";
}>;

export type RhythmView = Readonly<{
  buckets: readonly HourBucket[];
  max: number;
  peak: Readonly<{ hour: number; count: number }> | null;
  todayTotal: number;
  /** Yesterday's orders received up to this time of day; null without yesterday's list. */
  yesterdaySoFar: number | null;
  /** Position of "now" across the hour axis, 0..1. */
  nowFraction: number;
}>;

function minuteOfDay(ms: number): number {
  const date = new Date(ms);
  return date.getHours() * 60 + date.getMinutes();
}

function countByHour(timestamps: readonly number[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const value of timestamps) {
    const hour = new Date(toMillis(value)).getHours();
    counts.set(hour, (counts.get(hour) ?? 0) + 1);
  }
  return counts;
}

function hourRange(nowHour: number, counts: readonly Map<number, number>[]): [number, number] {
  let start = 8;
  let end = Math.max(20, nowHour);
  for (const map of counts) {
    for (const hour of map.keys()) {
      start = Math.min(start, hour);
      end = Math.max(end, hour);
    }
  }
  return [start, end];
}

/** Receipt times of the orders the day summary counts: open or closed, never drafts. */
export function receiptTimes(
  orders: readonly Readonly<{ status: string; created_at: number }>[],
): readonly number[] {
  return orders
    .filter((order) => order.status === "open" || order.status === "closed")
    .map((order) => order.created_at);
}

/** Orders received per hour today against yesterday, from each day's order timestamps. */
export function rhythmView(
  today: readonly number[],
  yesterday: readonly number[] | null,
  now: Date,
): RhythmView {
  const todayCounts = countByHour(today);
  const yesterdayCounts = countByHour(yesterday ?? []);
  const nowHour = now.getHours();
  const [start, end] = hourRange(nowHour, [todayCounts, yesterdayCounts]);
  const buckets: HourBucket[] = [];
  let peak: Readonly<{ hour: number; count: number }> | null = null;
  for (let hour = start; hour <= end; hour += 1) {
    const count = todayCounts.get(hour) ?? 0;
    const state = hour < nowHour ? "past" : hour === nowHour ? "now" : "future";
    buckets.push(
      Object.freeze({ hour, today: count, yesterday: yesterdayCounts.get(hour) ?? 0, state }),
    );
    if (count > 0 && (peak === null || count > peak.count)) peak = Object.freeze({ hour, count });
  }
  const max = Math.max(1, ...buckets.map((bucket) => Math.max(bucket.today, bucket.yesterday)));
  const cutoff = minuteOfDay(now.getTime());
  return Object.freeze({
    buckets: Object.freeze(buckets),
    max,
    peak,
    todayTotal: today.length,
    yesterdaySoFar:
      yesterday === null
        ? null
        : yesterday.filter((value) => minuteOfDay(toMillis(value)) <= cutoff).length,
    nowFraction: Math.min(1, (nowHour - start + now.getMinutes() / 60) / (end - start + 1)),
  });
}

export type DebtAging = Readonly<{
  count: number;
  sumFen: number;
  /** False when only the first pages were summed (the sum is a lower bound). */
  complete: boolean;
  within3: number;
  within7: number;
  over7: number;
  oldestDays: number;
}>;

/** Outstanding balances by age; ages use the order's receipt day. */
export function debtAging(
  rows: readonly Readonly<{ balance_cents: number; created_at: number }>[],
  total: number,
  nowMs: number,
): DebtAging {
  let sumFen = 0;
  let within3 = 0;
  let within7 = 0;
  let over7 = 0;
  let oldestDays = 0;
  for (const row of rows) {
    sumFen += row.balance_cents;
    const days = calendarDaysBetween(toMillis(row.created_at), nowMs);
    oldestDays = Math.max(oldestDays, days);
    if (days <= 3) within3 += 1;
    else if (days <= 7) within7 += 1;
    else over7 += 1;
  }
  return Object.freeze({
    count: total,
    sumFen,
    complete: rows.length >= total,
    within3,
    within7,
    over7,
    oldestDays,
  });
}

/** Furthest production step any of an order's in-store garments has reached. */
export type GarmentStage = "racked" | "ready" | "washing" | "received";

const STAGES: readonly GarmentStage[] = Object.freeze(["racked", "ready", "washing", "received"]);

export type GarmentGroup = Readonly<{
  racks: readonly string[];
  items: string;
  count: number;
  stage: GarmentStage;
}>;

function shortGarmentLabel(row: FulfillmentRowView): string {
  return knownCategoryLabel(row.category_code) ?? serviceLabel(row.service_code);
}

function itemsSummary(labels: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts].map(([label, count]) => `${label} ×${count}`).join("、");
}

/** In-store garments grouped by order: furthest stage, rack slots and an item summary. */
export function groupGarmentsByOrder(
  rows: readonly FulfillmentRowView[],
): ReadonlyMap<string, GarmentGroup> {
  const grouped = new Map<string, FulfillmentRowView[]>();
  for (const row of rows) {
    const list = grouped.get(row.order_id) ?? [];
    list.push(row);
    grouped.set(row.order_id, list);
  }
  const result = new Map<string, GarmentGroup>();
  for (const [orderId, list] of grouped) {
    const racks = [
      ...new Set(
        list
          .filter((row) => row.rack_zone !== null && row.rack_slot !== null)
          .map((row) => `${row.rack_zone}-${row.rack_slot}`),
      ),
    ];
    result.set(
      orderId,
      Object.freeze({
        racks: Object.freeze(racks),
        items: itemsSummary(list.map(shortGarmentLabel)),
        count: list.length,
        stage: STAGES.find((stage) => list.some((row) => row.status === stage)) ?? "received",
      }),
    );
  }
  return result;
}

export type StageView = Readonly<{
  key: "received" | "washing" | "ready" | "picked";
  label: string;
  count: number;
  /** The query is bounded; a full page means "at least this many". */
  capped: boolean;
}>;

export const PRODUCTION_PAGE = 100;

/** The four production stages the side card draws, left to right. */
export function productionStages(
  received: number,
  washing: number,
  ready: number,
  pickedToday: number,
): readonly StageView[] {
  const stage = (key: StageView["key"], label: string, count: number, bounded: boolean) =>
    Object.freeze({ key, label, count, capped: bounded && count >= PRODUCTION_PAGE });
  return Object.freeze([
    stage("received", "已收件", received, true),
    stage("washing", "洗涤中", washing, true),
    stage("ready", "待取", ready, true),
    stage("picked", "今日已取", pickedToday, false),
  ]);
}

/** Segment widths (0..100, summing to 100) for a bar of stage counts; empty stages vanish. */
export function segmentWidths(counts: readonly number[]): readonly number[] {
  const total = counts.reduce((sum, count) => sum + Math.max(0, count), 0);
  if (total === 0) return Object.freeze(counts.map(() => 0));
  return Object.freeze(counts.map((count) => (Math.max(0, count) / total) * 100));
}

/** "37 件" style count with an at-least marker for bounded queries. */
export function boundedCount(count: number, capped: boolean): string {
  return capped ? `${count}+` : String(count);
}
