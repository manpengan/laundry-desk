/** Three-pane counter home: scan-first pickup, today view, and customer shortcuts. */

import { Button, Input, MoneyText, StatusBadge, useToast } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { QueryPort } from "../commands/types.js";
import type { NavItemId } from "../nav.js";
import { parseCustomerRows, unwrapQueryResult as unwrapCustomers } from "./CustomersPage.js";
import {
  parseOrderListRows,
  unwrapQueryResult as unwrapOrders,
  type OrderListRowView,
} from "./OrdersList.js";
import { parseOrderLookupRows } from "./OrderLookupCandidates.js";
import {
  parseDaySummary,
  unwrapQueryResult as unwrapStats,
  type DaySummaryView,
} from "./StatsPage.js";

export type CounterWorkbenchProps = Readonly<{
  queryClient: QueryPort;
  onNavigate: (id: NavItemId) => void;
  onOpenPickup: (orderId: string) => void;
  onOpenPickupLookup: (key: string) => void;
}>;

export function CounterWorkbench({
  queryClient,
  onNavigate,
  onOpenPickup,
  onOpenPickupLookup,
}: CounterWorkbenchProps) {
  const toast = useToast();
  const [pickupKey, setPickupKey] = useState("");
  const [customerKey, setCustomerKey] = useState("");
  const [orders, setOrders] = useState<readonly OrderListRowView[]>([]);
  const [summary, setSummary] = useState<DaySummaryView | null>(null);
  const [customerNames, setCustomerNames] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const loadRef = useRef<() => Promise<void>>(async () => undefined);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const statsRes = await queryClient.execute<unknown>("stats.day.summary", {});
      if (statsRes.ok) {
        const parsedSummary = parseDaySummary(unwrapStats(statsRes.data));
        setSummary(parsedSummary);
        if (parsedSummary === null) {
          setOrders([]);
          toast.push("今日看板结果无法解析", "error");
          return;
        }
        const ordersRes = await queryClient.execute<unknown>("order.list", {
          business_date: parsedSummary.business_date,
          status: "open",
          limit: 8,
        });
        if (ordersRes.ok) {
          setOrders(parseOrderListRows(unwrapOrders(ordersRes.data)) ?? []);
        } else {
          toast.push(ordersRes.error.message ?? ordersRes.error.code, "error");
        }
      } else {
        setOrders([]);
        toast.push(statsRes.error.message ?? statsRes.error.code, "error");
      }
    } finally {
      setBusy(false);
    }
  }, [queryClient, toast]);

  loadRef.current = load;
  useEffect(() => {
    void loadRef.current();
  }, []);

  const onPickupSearch = useCallback(async () => {
    const key = pickupKey.trim();
    if (key.length === 0) {
      toast.push("请输入票号、取件码、衣物条码、手机号或姓名", "error");
      return;
    }
    setBusy(true);
    try {
      const res = await queryClient.execute<unknown>("order.lookup", {
        key,
        status: "open",
        limit: 20,
      });
      if (!res.ok) {
        toast.push(res.error.message ?? res.error.code, "error");
        return;
      }
      const found = parseOrderLookupRows(unwrapOrders(res.data));
      if (found === null) {
        toast.push("订单查询结果无法解析", "error");
        return;
      }
      if (found.length === 0) {
        toast.push("未找到匹配订单；可按客户继续查找", "error");
        return;
      }
      if (found.length === 1) onOpenPickup(found[0]!.order_id);
      else onOpenPickupLookup(key);
    } finally {
      setBusy(false);
    }
  }, [onOpenPickup, onOpenPickupLookup, pickupKey, queryClient, toast]);

  const onCustomerSearch = useCallback(async () => {
    const key = customerKey.trim();
    if (key.length === 0) {
      onNavigate("customers");
      return;
    }
    setBusy(true);
    try {
      const res = await queryClient.execute<unknown>("customer.search", { query: key, limit: 4 });
      if (!res.ok) {
        toast.push(res.error.message ?? res.error.code, "error");
        return;
      }
      const customers = parseCustomerRows(unwrapCustomers(res.data)) ?? [];
      setCustomerNames(
        customers.map((customer) => `${customer.name ?? "未命名客户"} · ${customer.phone}`),
      );
    } finally {
      setBusy(false);
    }
  }, [customerKey, onNavigate, queryClient, toast]);

  return (
    <main className="ld-shell-main lg-card" id="main-content" tabIndex={-1}>
      <h1 className="ld-shell-main__title">工作台</h1>
      <p className="ld-shell-main__hint">
        扫描或输入票号、取件码或衣物条码即可进入取衣；今日数据按服务端营业日计算。
      </p>
      <div className="ld-counter-grid ld-counter-grid--workbench">
        <section className="ld-counter-panel" aria-label="快捷取衣">
          <h2 className="ld-counter-panel__title">快捷取衣</h2>
          <div className="ld-workbench-search">
            <Input
              name="quick-pickup"
              label="票号 / 取件码 / 条码 / 手机号 / 姓名"
              value={pickupKey}
              onChange={(event) => setPickupKey(event.target.value)}
              autoFocus
              disabled={busy}
              hint="扫码枪可直接输入后按 Enter"
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void onPickupSearch();
                }
              }}
            />
            <Button
              variant="primary"
              type="button"
              onClick={() => void onPickupSearch()}
              disabled={busy}
            >
              进入取衣
            </Button>
          </div>
          <div className="ld-workbench-actions">
            <Button variant="secondary" type="button" onClick={() => onNavigate("receive")}>
              开单
            </Button>
            <Button variant="ghost" type="button" onClick={() => onNavigate("stats")}>
              日结与交班
            </Button>
          </div>
        </section>
        <section className="ld-counter-panel" aria-label="今日看板">
          <div className="ld-counter-panel__head">
            <h2 className="ld-counter-panel__title">今日看板</h2>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => void load()}
              disabled={busy}
            >
              {busy ? "刷新中…" : "刷新"}
            </Button>
          </div>
          <div className="ld-workbench-metrics" data-testid="counter-workbench-metrics">
            <Metric label="收衣" value={summary === null ? "—" : `${summary.order_count} 单`} />
            <Metric label="衣物" value={summary === null ? "—" : `${summary.garment_count} 件`} />
            <Metric
              label="实收"
              value={summary === null ? "—" : <MoneyText fen={summary.payment_cents} />}
            />
            <Metric
              label="欠款"
              value={summary === null ? "—" : <MoneyText fen={summary.balance_cents} />}
            />
          </div>
          <h3 className="ld-counter-panel__title">今日待取</h3>
          <ul className="ld-workbench-orders" data-testid="counter-workbench-orders">
            {orders.length === 0 ? (
              <li className="ld-workbench-empty">暂无待取订单</li>
            ) : (
              orders.map((order) => (
                <li key={order.order_id}>
                  <button
                    type="button"
                    className="ld-workbench-orders__row"
                    onClick={() => onOpenPickup(order.order_id)}
                  >
                    <span>
                      <span className="ld-workbench-orders__ticket">
                        {order.ticket_no ?? "挂单"}
                      </span>
                      <span className="ld-workbench-orders__sub">
                        {" "}
                        · {order.customer_name ?? order.customer_phone ?? "散客"}
                      </span>
                    </span>
                    <span>
                      <StatusBadge family="order" status={order.status} />
                    </span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </section>
        <section className="ld-counter-panel" aria-label="顾客速查">
          <h2 className="ld-counter-panel__title">顾客速查</h2>
          <Input
            name="quick-customer"
            label="姓名或手机号"
            value={customerKey}
            onChange={(event) => setCustomerKey(event.target.value)}
            disabled={busy}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void onCustomerSearch();
              }
            }}
          />
          <div className="ld-workbench-actions">
            <Button
              variant="secondary"
              type="button"
              onClick={() => void onCustomerSearch()}
              disabled={busy}
            >
              查客户
            </Button>
            <Button variant="ghost" type="button" onClick={() => onNavigate("customers")}>
              客户档案
            </Button>
          </div>
          <ul className="ld-workbench-customers">
            {customerNames.length === 0 ? (
              <li className="ld-workbench-empty">输入关键词后显示最近匹配客户</li>
            ) : (
              customerNames.map((name) => (
                <li className="ld-workbench-customers__row" key={name}>
                  {name}
                </li>
              ))
            )}
          </ul>
        </section>
      </div>
    </main>
  );
}

function Metric({ label, value }: Readonly<{ label: string; value: ReactNode }>) {
  return (
    <article className="ld-workbench-metric">
      <span className="ld-workbench-metric__label">{label}</span>
      <strong className="ld-workbench-metric__value">{value}</strong>
    </article>
  );
}
