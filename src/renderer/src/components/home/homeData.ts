import { useEffect, useRef, useState } from "react";
import type { CustomerDto, OrderWithDetailsDto, StatsDto } from "@shared/index";

export type Period = "today" | "week" | "month";
export const periodLabel: Record<Period, string> = {
  today: "今日",
  week: "本周",
  month: "本月",
};

export const yuan = (cents: number): string => {
  const y = cents / 100;
  return y % 1 === 0
    ? y.toLocaleString("zh-CN")
    : y.toLocaleString("zh-CN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
};

export function useCountUp(target: number, duration = 850): number {
  const [value, setValue] = useState(target);
  const prev = useRef(target);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      prev.current = target;
      setValue(target);
      return;
    }
    const from = prev.current;
    prev.current = target;
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number): void => {
      const p = Math.min(1, (t - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setValue(from + (target - from) * eased);
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, duration]);
  return value;
}

export interface PeriodView {
  income: number;
  count: number;
  pieces: string;
  newCustomers: number;
  chip: string | null;
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d;
}

export function buildView(
  period: Period,
  stats: StatsDto,
  orders: OrderWithDetailsDto[],
  customers: CustomerDto[],
): PeriodView {
  const boundary =
    period === "today"
      ? daysAgo(0)
      : period === "week"
        ? daysAgo(6)
        : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const inPeriod = orders.filter(
    (o) => o.receiveDate && new Date(o.receiveDate) >= boundary,
  );
  const pieceCount = inPeriod.reduce(
    (s, o) => s + o.items.reduce((a, i) => a + i.quantity, 0),
    0,
  );
  const newCustomers = customers.filter(
    (c) => c.createdAt && new Date(c.createdAt) >= boundary,
  ).length;

  const recent = stats.chartData;
  const sum = (rows: typeof recent): number =>
    rows.reduce((s, r) => s + r.income, 0);
  let income = stats.todayIncome;
  let count = stats.todayCount;
  let base = 0;
  if (period === "today") {
    base = recent.length >= 2 ? recent[recent.length - 2].income : 0;
  } else if (period === "week") {
    income = sum(recent.slice(-7));
    count = recent.slice(-7).reduce((s, r) => s + r.count, 0);
    base = recent.length >= 14 ? sum(recent.slice(-14, -7)) : 0;
  } else {
    income = stats.monthIncome;
    count = stats.monthCount;
  }
  const chip =
    base > 0
      ? `${income >= base ? "+" : ""}${(((income - base) / base) * 100).toFixed(1)}%`
      : null;
  const pieces =
    orders.length >= 60 && period !== "today"
      ? `≈${pieceCount}`
      : String(pieceCount);
  return { income, count, pieces, newCustomers, chip };
}

export function orderStatus(o: OrderWithDetailsDto): {
  cls: string;
  text: string;
} {
  if (o.status === "cancelled") return { cls: "done", text: "已取消" };
  if (o.status === "picked_up") return { cls: "done", text: "已取" };
  if (o.status === "ready") return { cls: "ok", text: "待取" };
  if (o.expectedPickupDate) {
    const days = Math.floor(
      (Date.now() - new Date(o.expectedPickupDate).getTime()) / 86400000,
    );
    if (days > 0) return { cls: "late", text: `逾期 ${days} 天` };
  }
  return { cls: "busy", text: "在洗" };
}

export const serviceTypeLabel: Record<string, string> = {
  wash: "水洗",
  dry_clean: "干洗",
  iron: "熨烫",
};

export const itemSummary = (o: OrderWithDetailsDto): string => {
  const parts = o.items
    .map((i) => (i.quantity > 1 ? `${i.itemType} ×${i.quantity}` : i.itemType))
    .join(" · ");
  if (!parts) return "—";
  const services = new Set(o.items.map((i) => i.serviceType));
  const suffix = services.size === 1 ? serviceTypeLabel[[...services][0]] : "";
  return suffix ? `${parts} · ${suffix}` : parts;
};
