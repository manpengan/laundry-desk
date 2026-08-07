import { Button, EmptyState, MoneyText, Skeleton } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState } from "react";

import type { QueryPort } from "../commands/types.js";
import {
  loadOwnerDrilldown,
  type OwnerDrilldownData,
  type OwnerDrilldownKind,
} from "./owner-operations-model.js";

export type OwnerDrilldownPanelProps = Readonly<{
  queryClient: QueryPort;
  kind: OwnerDrilldownKind | null;
  onClose: () => void;
}>;

export type OwnerDrilldownViewProps = Readonly<{
  kind: OwnerDrilldownKind;
  data: OwnerDrilldownData | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onClose: () => void;
}>;

const TITLES: Readonly<Record<OwnerDrilldownKind, string>> = Object.freeze({
  today_pickups: "今日取衣明细",
  new_receivables: "今日新增欠款明细",
  stagnant_garments: "滞留件明细",
});

function timestampLabel(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function DrilldownSummary({ data }: Readonly<{ data: OwnerDrilldownData }>) {
  if (data.kind === "today_pickups") {
    return (
      <strong>
        共 {data.totals.picked_up_order_count} 单 · {data.totals.picked_up_garment_count} 件
      </strong>
    );
  }
  if (data.kind === "new_receivables") {
    return (
      <strong>
        共 {data.totals.new_receivable_order_count} 单 · 欠款
        <MoneyText fen={data.totals.new_receivable_cents} size="sm" />
      </strong>
    );
  }
  return (
    <strong>
      共 {data.totals.overdue_order_count} 单 · {data.totals.overdue_garment_count} 件
    </strong>
  );
}

function DrilldownTable({ data }: Readonly<{ data: OwnerDrilldownData }>) {
  if (data.kind === "today_pickups") {
    return (
      <table className="ld-owner-operations__table">
        <thead>
          <tr>
            <th scope="col">票号</th>
            <th scope="col">取衣时间</th>
            <th scope="col">件数</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr key={row.ticket_no}>
              <th scope="row">{row.ticket_no}</th>
              <td>{timestampLabel(row.picked_at)}</td>
              <td>{row.garment_count} 件</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (data.kind === "new_receivables") {
    return (
      <table className="ld-owner-operations__table">
        <thead>
          <tr>
            <th scope="col">票号</th>
            <th scope="col">收衣时间</th>
            <th scope="col">未收回</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr key={row.ticket_no}>
              <th scope="row">{row.ticket_no}</th>
              <td>{timestampLabel(row.received_at)}</td>
              <td>
                <MoneyText fen={row.balance_cents} size="sm" />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return (
    <table className="ld-owner-operations__table">
      <thead>
        <tr>
          <th scope="col">票号</th>
          <th scope="col">收衣时间</th>
          <th scope="col">账龄</th>
          <th scope="col">件数</th>
          <th scope="col">欠款</th>
        </tr>
      </thead>
      <tbody>
        {data.rows.map((row) => (
          <tr key={row.ticket_no}>
            <th scope="row">{row.ticket_no}</th>
            <td>{timestampLabel(row.received_at)}</td>
            <td>{row.age_days} 天</td>
            <td>{row.garment_count} 件</td>
            <td>
              <MoneyText fen={row.balance_cents} size="sm" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function OwnerDrilldownView({
  kind,
  data,
  loading,
  error,
  onRetry,
  onClose,
}: OwnerDrilldownViewProps) {
  const currentData = error === null && data?.kind === kind ? data : null;
  return (
    <section
      className="ld-owner-operations lg-card"
      aria-labelledby="owner-drilldown-title"
      data-testid="owner-drilldown"
      aria-busy={loading}
    >
      <header className="ld-owner-operations__header">
        <div>
          <span className="ld-owner-operations__eyebrow">当前门店 · 只读</span>
          <h2 id="owner-drilldown-title">{TITLES[kind]}</h2>
          {currentData === null ? null : <DrilldownSummary data={currentData} />}
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          关闭明细
        </Button>
      </header>
      {currentData === null && loading ? (
        <div role="status">
          <Skeleton lines={4} rounded="md" />
        </div>
      ) : null}
      {currentData === null && error !== null ? (
        <div className="ld-owner-operations__error" role="alert">
          <span>{error}</span>
          <Button type="button" size="sm" variant="secondary" onClick={onRetry}>
            重新加载
          </Button>
        </div>
      ) : null}
      {currentData !== null && currentData.rows.length === 0 ? (
        <EmptyState title="暂无明细" description="当前营业日没有符合这项口径的订单。" />
      ) : null}
      {currentData !== null && currentData.rows.length > 0 ? (
        <div className="ld-owner-operations__table-wrap">
          <DrilldownTable data={currentData} />
        </div>
      ) : null}
      {currentData?.truncated ? (
        <p className="ld-owner-operations__notice" role="status">
          只展示前 50 单；上方汇总仍是完整口径。
        </p>
      ) : null}
    </section>
  );
}

export function OwnerDrilldownPanel({ queryClient, kind, onClose }: OwnerDrilldownPanelProps) {
  const [data, setData] = useState<OwnerDrilldownData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (kind === null) return;
    const current = generation.current + 1;
    generation.current = current;
    setLoading(true);
    setError(null);
    const result = await loadOwnerDrilldown(queryClient, kind);
    if (generation.current !== current) return;
    if (result.ok) setData(result.data);
    else {
      setData(null);
      setError(result.error);
    }
    setLoading(false);
  }, [kind, queryClient]);

  useEffect(() => {
    if (kind === null) return;
    setData(null);
    void load();
    return () => {
      generation.current += 1;
    };
  }, [kind, load]);

  if (kind === null) return null;
  return (
    <OwnerDrilldownView
      kind={kind}
      data={data}
      loading={loading}
      error={error}
      onRetry={() => void load()}
      onClose={onClose}
    />
  );
}
