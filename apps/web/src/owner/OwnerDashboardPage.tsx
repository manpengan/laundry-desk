import { Button, EmptyState, MoneyText, Skeleton } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState } from "react";

import type { QueryPort } from "../commands/types.js";
import {
  loadOwnerDashboard,
  selectOwnerTrend,
  type OwnerDashboardData,
  type OwnerTrendDays,
} from "./owner-dashboard-model.js";

export type OwnerDashboardPageProps = Readonly<{
  queryClient: QueryPort;
  /** Unit/SSR escape hatch; production loads immediately. */
  autoLoad?: boolean;
}>;

export type OwnerDashboardViewProps = Readonly<{
  dashboard: OwnerDashboardData | null;
  loading: boolean;
  error: string | null;
  trendDays: OwnerTrendDays;
  onTrendDaysChange: (days: OwnerTrendDays) => void;
  onRefresh: () => void;
}>;

function shortBusinessDate(value: string): string {
  return `${value.slice(5, 7)}月${value.slice(8, 10)}日`;
}

function generatedAtLabel(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function OwnerDashboardLoading() {
  return (
    <section className="ld-owner-state" data-state="loading" role="status" aria-live="polite">
      <span className="ld-owner-state__eyebrow">正在读取经营数据</span>
      <div className="ld-owner-metrics" aria-hidden>
        {Array.from({ length: 4 }, (_, index) => (
          <div className="ld-owner-metric lg-card" key={`owner-metric-${index}`}>
            <Skeleton lines={3} rounded="md" />
          </div>
        ))}
      </div>
      <div className="ld-owner-trend lg-card" aria-hidden>
        <Skeleton lines={5} rounded="md" />
      </div>
    </section>
  );
}

function OwnerMetricCard({
  label,
  value,
  detail,
  tone,
}: Readonly<{
  label: string;
  value: React.ReactNode;
  detail: React.ReactNode;
  tone: "income" | "pickup" | "debt" | "overdue";
}>) {
  return (
    <article className="ld-owner-metric lg-card" data-tone={tone}>
      <span className="ld-owner-metric__label">{label}</span>
      <strong className="ld-owner-metric__value">{value}</strong>
      <span className="ld-owner-metric__detail">{detail}</span>
    </article>
  );
}

function OwnerTrend({
  dashboard,
  days,
  onDaysChange,
}: Readonly<{
  dashboard: OwnerDashboardData;
  days: OwnerTrendDays;
  onDaysChange: (days: OwnerTrendDays) => void;
}>) {
  const rows = selectOwnerTrend(dashboard, days);
  return (
    <section className="ld-owner-trend lg-card" aria-labelledby="owner-trend-title">
      <header className="ld-owner-trend__header">
        <div>
          <h2 id="owner-trend-title">营业趋势</h2>
          <p>业绩与实收均来自同一份 30 日权威快照</p>
        </div>
        <div className="ld-owner-trend__switch" aria-label="趋势范围">
          {([7, 30] as const).map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={days === value ? "primary" : "ghost"}
              aria-pressed={days === value}
              onClick={() => onDaysChange(value)}
            >
              近 {value} 日
            </Button>
          ))}
        </div>
      </header>
      <div className="ld-owner-trend__table-wrap">
        <table className="ld-owner-trend__table">
          <thead>
            <tr>
              <th scope="col">营业日</th>
              <th scope="col">业绩</th>
              <th scope="col">实收</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.business_date} data-testid="owner-trend-row">
                <th scope="row">{shortBusinessDate(row.business_date)}</th>
                <td>
                  <MoneyText fen={row.performance_income_cents} size="sm" />
                </td>
                <td>
                  <MoneyText fen={row.real_income_cents} size="sm" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function OwnerDashboardView({
  dashboard,
  loading,
  error,
  trendDays,
  onTrendDaysChange,
  onRefresh,
}: OwnerDashboardViewProps) {
  if (dashboard === null && loading) {
    return (
      <div data-testid="owner-dashboard">
        <OwnerDashboardLoading />
      </div>
    );
  }
  if (dashboard === null && error !== null) {
    return (
      <section className="ld-owner-state lg-card" data-state="error" data-testid="owner-dashboard">
        <div className="ld-owner-state__alert" role="alert">
          <strong>经营数据加载失败</strong>
          <span>{error}</span>
        </div>
        <Button type="button" variant="primary" onClick={onRefresh}>
          重新加载
        </Button>
      </section>
    );
  }
  if (dashboard === null) {
    return (
      <section className="ld-owner-state lg-card" data-state="empty" data-testid="owner-dashboard">
        <EmptyState
          title="暂无经营数据"
          description="刷新后会读取当前营业日和最近 30 日的只读汇总。"
          actionLabel="立即刷新"
          onAction={onRefresh}
        />
      </section>
    );
  }

  return (
    <div
      className="ld-owner-dashboard"
      data-state="ready"
      data-testid="owner-dashboard"
      aria-busy={loading}
    >
      <header className="ld-owner-dashboard__heading">
        <div>
          <span className="ld-owner-dashboard__date">{dashboard.business_date}</span>
          <h1>今日经营</h1>
          <p>只读汇总 · 更新于 {generatedAtLabel(dashboard.generated_at)}</p>
        </div>
        <Button
          type="button"
          variant="secondary"
          onClick={onRefresh}
          disabled={loading}
          aria-label="刷新经营数据"
        >
          {loading ? "刷新中…" : "刷新数据"}
        </Button>
      </header>

      {error === null ? null : (
        <div className="ld-owner-dashboard__refresh-error" role="alert">
          本次刷新失败：{error}。当前仍显示上次成功数据。
        </div>
      )}

      <section className="ld-owner-metrics" aria-label="今日经营指标">
        <OwnerMetricCard
          label="今日营业额"
          value={<MoneyText fen={dashboard.today.performance_income_cents} size="xl" />}
          detail={
            <>
              实收 <MoneyText fen={dashboard.today.real_income_cents} size="sm" />
              <small>业绩看洗护消费，实收看现金流</small>
            </>
          }
          tone="income"
        />
        <OwnerMetricCard
          label="今日取衣件数"
          value={`${dashboard.today.picked_up_garment_count} 件`}
          detail="按今日完成的取衣事件计件"
          tone="pickup"
        />
        <OwnerMetricCard
          label="新增欠款"
          value={<MoneyText fen={dashboard.today.new_receivable_cents} size="xl" />}
          detail={`${dashboard.today.new_receivable_order_count} 单 · 当前尚未收回`}
          tone="debt"
        />
        <OwnerMetricCard
          label="滞留件"
          value={`${dashboard.today.overdue_garment_count} 件`}
          detail={`${dashboard.today.overdue_order_count} 单 · 满 ${dashboard.overdue_min_age_days} 天`}
          tone="overdue"
        />
      </section>

      <OwnerTrend dashboard={dashboard} days={trendDays} onDaysChange={onTrendDaysChange} />
    </div>
  );
}

export function OwnerDashboardPage({ queryClient, autoLoad = true }: OwnerDashboardPageProps) {
  const [dashboard, setDashboard] = useState<OwnerDashboardData | null>(null);
  const [loading, setLoading] = useState(autoLoad);
  const [error, setError] = useState<string | null>(null);
  const [trendDays, setTrendDays] = useState<OwnerTrendDays>(7);
  const loadGeneration = useRef(0);
  const loadRef = useRef<() => Promise<void>>(async () => undefined);

  const load = useCallback(async () => {
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    setLoading(true);
    setError(null);
    try {
      const result = await loadOwnerDashboard(queryClient);
      if (generation !== loadGeneration.current) return;
      if (result.ok) {
        setDashboard(result.data);
      } else {
        setError(result.error);
      }
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [queryClient]);

  loadRef.current = load;
  useEffect(() => {
    if (!autoLoad) return;
    void loadRef.current();
    return () => {
      loadGeneration.current += 1;
    };
  }, [autoLoad]);

  return (
    <OwnerDashboardView
      dashboard={dashboard}
      loading={loading}
      error={error}
      trendDays={trendDays}
      onTrendDaysChange={setTrendDays}
      onRefresh={() => void load()}
    />
  );
}
