import { Button, EmptyState, MoneyText, Skeleton } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState } from "react";

import type { QueryPort } from "../commands/types.js";
import {
  loadOwnerPortfolio,
  type OwnerPortfolioData,
  type OwnerPortfolioMetrics,
} from "./owner-operations-model.js";

export type OwnerPortfolioViewProps = Readonly<{
  data: OwnerPortfolioData | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}>;

function PortfolioTotals({ metrics }: Readonly<{ metrics: OwnerPortfolioMetrics }>) {
  return (
    <div className="ld-owner-portfolio__totals" aria-label="授权门店总计">
      <span>
        业绩 <MoneyText fen={metrics.performance_income_cents} size="sm" />
      </span>
      <span>
        实收 <MoneyText fen={metrics.real_income_cents} size="sm" />
      </span>
      <span>取衣 {metrics.picked_up_garment_count} 件</span>
      <span>
        新增欠款 <MoneyText fen={metrics.new_receivable_cents} size="sm" />
      </span>
      <span>滞留 {metrics.overdue_garment_count} 件</span>
    </div>
  );
}

export function OwnerPortfolioView({ data, loading, error, onRefresh }: OwnerPortfolioViewProps) {
  const currentData = error === null ? data : null;
  return (
    <section
      className="ld-owner-operations lg-card"
      aria-labelledby="owner-portfolio-title"
      data-testid="owner-portfolio"
      aria-busy={loading}
    >
      <header className="ld-owner-operations__header">
        <div>
          <span className="ld-owner-operations__eyebrow">逐店重新校验管理员权限</span>
          <h2 id="owner-portfolio-title">授权门店对比</h2>
          <p>只显示当前账号仍是店长的门店</p>
        </div>
        <Button type="button" size="sm" variant="secondary" disabled={loading} onClick={onRefresh}>
          {loading ? "刷新中…" : "刷新对比"}
        </Button>
      </header>
      {currentData === null && loading ? (
        <div role="status">
          <Skeleton lines={5} rounded="md" />
        </div>
      ) : null}
      {currentData === null && error !== null ? (
        <div className="ld-owner-operations__error" role="alert">
          <span>{error}</span>
          <Button type="button" size="sm" variant="secondary" onClick={onRefresh}>
            重新加载
          </Button>
        </div>
      ) : null}
      {currentData !== null ? <PortfolioTotals metrics={currentData.totals} /> : null}
      {currentData !== null && currentData.stores.length === 0 ? (
        <EmptyState
          title="没有其他授权门店"
          description="仅当当前账号在门店仍为有效店长时，该门店才会出现在这里。"
        />
      ) : null}
      {currentData !== null && currentData.stores.length > 0 ? (
        <div className="ld-owner-operations__table-wrap">
          <table className="ld-owner-operations__table ld-owner-portfolio__table">
            <thead>
              <tr>
                <th scope="col">门店</th>
                <th scope="col">营业日</th>
                <th scope="col">业绩</th>
                <th scope="col">实收</th>
                <th scope="col">取衣</th>
                <th scope="col">新增欠款</th>
                <th scope="col">滞留</th>
              </tr>
            </thead>
            <tbody>
              {currentData.stores.map((store) => (
                <tr key={store.store_code}>
                  <th scope="row">
                    <strong>{store.store_name}</strong>
                    <small>
                      {store.store_code} · {store.timezone}
                    </small>
                  </th>
                  <td>{store.business_date}</td>
                  <td>
                    <MoneyText fen={store.performance_income_cents} size="sm" />
                  </td>
                  <td>
                    <MoneyText fen={store.real_income_cents} size="sm" />
                  </td>
                  <td>{store.picked_up_garment_count} 件</td>
                  <td>
                    <MoneyText fen={store.new_receivable_cents} size="sm" />
                    <small>{store.new_receivable_order_count} 单</small>
                  </td>
                  <td>
                    {store.overdue_garment_count} 件<small>{store.overdue_order_count} 单</small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {currentData?.truncated ? (
        <p className="ld-owner-operations__notice" role="status">
          授权门店超过 50 家；本页总计只汇总当前返回的 50 家。
        </p>
      ) : null}
    </section>
  );
}

export function OwnerPortfolioPanel({ queryClient }: Readonly<{ queryClient: QueryPort }>) {
  const [data, setData] = useState<OwnerPortfolioData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const current = generation.current + 1;
    generation.current = current;
    setLoading(true);
    setError(null);
    const result = await loadOwnerPortfolio(queryClient);
    if (generation.current !== current) return;
    if (result.ok) setData(result.data);
    else {
      setData(null);
      setError(result.error);
    }
    setLoading(false);
  }, [queryClient]);
  useEffect(() => {
    void load();
    return () => {
      generation.current += 1;
    };
  }, [load]);
  return (
    <OwnerPortfolioView data={data} loading={loading} error={error} onRefresh={() => void load()} />
  );
}
