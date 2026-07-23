/**
 * 日结统计 — stats.day.summary counter surface (M2 skeleton).
 */

import { Button, Input, MoneyText, useToast } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { QueryPort } from "../commands/types.js";
import { downloadDaySummaryCsv } from "./day-summary-csv.js";

export type DaySummaryView = Readonly<{
  business_date: string;
  order_count: number;
  garment_count: number;
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
  payment_cents: number;
  picked_garment_count: number;
}>;

export type StatsPageProps = {
  queryClient: QueryPort;
  /** Override default date (tests). */
  defaultDate?: string;
  /** Skip auto-load on mount (tests). */
  autoLoad?: boolean;
};

/** Local calendar YYYY-MM-DD (counter default day). */
export function localYmd(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

/** Unwrap bus `{ execution, result }` or bare result. */
export function unwrapQueryResult(data: unknown): unknown {
  if (!isRecord(data)) return data;
  if ("result" in data) return data.result;
  return data;
}

export function parseDaySummary(value: unknown): DaySummaryView | null {
  if (!isRecord(value)) return null;
  if (typeof value.business_date !== "string") return null;
  const order_count = asInt(value.order_count);
  const garment_count = asInt(value.garment_count);
  const payable_cents = asInt(value.payable_cents);
  const paid_cents = asInt(value.paid_cents);
  const balance_cents = asInt(value.balance_cents);
  const payment_cents = asInt(value.payment_cents);
  const picked_garment_count = asInt(value.picked_garment_count);
  if (
    order_count === null ||
    garment_count === null ||
    payable_cents === null ||
    paid_cents === null ||
    balance_cents === null ||
    payment_cents === null ||
    picked_garment_count === null
  ) {
    return null;
  }
  return Object.freeze({
    business_date: value.business_date,
    order_count,
    garment_count,
    payable_cents,
    paid_cents,
    balance_cents,
    payment_cents,
    picked_garment_count,
  });
}

export function StatsPage({ queryClient, defaultDate, autoLoad = true }: StatsPageProps) {
  const toast = useToast();
  const [dateText, setDateText] = useState(() => defaultDate ?? localYmd());
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<DaySummaryView | null>(null);
  const loadRef = useRef<() => Promise<void>>(async () => undefined);

  const load = useCallback(async () => {
    const businessDate = dateText.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(businessDate)) {
      toast.push("请输入日期 YYYY-MM-DD", "error");
      return;
    }
    setBusy(true);
    try {
      const res = await queryClient.execute<unknown>("stats.day.summary", {
        business_date: businessDate,
      });
      if (!res.ok) {
        toast.push(res.error.message ?? res.error.code, "error");
        setSummary(null);
        return;
      }
      const parsed = parseDaySummary(unwrapQueryResult(res.data));
      if (parsed === null) {
        toast.push("日结结果无法解析", "error");
        setSummary(null);
        return;
      }
      setSummary(parsed);
    } finally {
      setBusy(false);
    }
  }, [dateText, queryClient, toast]);

  loadRef.current = load;

  useEffect(() => {
    if (!autoLoad) return;
    void loadRef.current();
  }, [autoLoad]);

  return (
    <main className="ld-shell-main lg-card" id="main-content" tabIndex={-1}>
      <h1 className="ld-shell-main__title">统计</h1>
      <p className="ld-shell-main__hint">日结汇总：按营业日聚合开单、衣物件数与整数分金额。</p>

      <div className="ld-stats-form">
        <Input
          name="business-date"
          label="营业日"
          type="date"
          value={dateText}
          onChange={(event) => setDateText(event.target.value)}
          disabled={busy}
          data-testid="stats-date-input"
        />
        <div className="ld-stats-form__actions">
          <Button
            variant="primary"
            type="button"
            onClick={() => void load()}
            disabled={busy}
            data-testid="stats-load-btn"
          >
            {busy ? "加载中…" : "查询日结"}
          </Button>
          <Button
            variant="secondary"
            type="button"
            onClick={() => {
              if (summary === null) {
                toast.push("请先查询日结", "error");
                return;
              }
              downloadDaySummaryCsv(summary);
            }}
            disabled={busy || summary === null}
            data-testid="stats-export-csv-btn"
          >
            导出 CSV
          </Button>
        </div>
      </div>

      {summary !== null ? (
        <div className="ld-stats-grid" data-testid="stats-summary">
          <MetricCard
            testId="stats-card-orders"
            label="开单笔数"
            value={<span className="ld-stats-metric__num">{summary.order_count}</span>}
            foot={`衣物 ${summary.garment_count} 件`}
          />
          <MetricCard
            testId="stats-card-garments"
            label="衣物件数"
            value={<span className="ld-stats-metric__num">{summary.garment_count}</span>}
            foot={`已取 ${summary.picked_garment_count} 件`}
          />
          <MetricCard
            testId="stats-card-payable"
            label="应收"
            value={<MoneyText fen={summary.payable_cents} size="lg" />}
            foot={`已收 ${summary.paid_cents} 分`}
          />
          <MetricCard
            testId="stats-card-paid"
            label="已收（订单）"
            value={<MoneyText fen={summary.paid_cents} size="lg" />}
            foot={`余额 ${summary.balance_cents} 分`}
          />
          <MetricCard
            testId="stats-card-balance"
            label="余额"
            value={<MoneyText fen={summary.balance_cents} size="lg" />}
            foot="当日订单 balance 合计"
          />
          <MetricCard
            testId="stats-card-payment"
            label="收款流水"
            value={<MoneyText fen={summary.payment_cents} size="lg" />}
            foot="payments.kind=pay 当日合计"
          />
          <MetricCard
            testId="stats-card-picked"
            label="已取件数"
            value={<span className="ld-stats-metric__num">{summary.picked_garment_count}</span>}
            foot={`营业日 ${summary.business_date}`}
          />
        </div>
      ) : null}
    </main>
  );
}

function MetricCard(props: { testId: string; label: string; value: ReactNode; foot: string }) {
  return (
    <article className="ld-stats-card" data-testid={props.testId}>
      <div className="ld-stats-card__label">{props.label}</div>
      <div className="ld-stats-card__value">{props.value}</div>
      <div className="ld-stats-card__foot">{props.foot}</div>
    </article>
  );
}
