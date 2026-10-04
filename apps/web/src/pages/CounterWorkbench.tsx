/** Three-pane counter home: scan-first pickup, today view, and customer shortcuts. */

import {
  Button,
  EmptyState,
  Icon,
  Input,
  MoneyText,
  NumberPad,
  StatusBadge,
  useToast,
  type IconName,
} from "@laundry/ui";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { QueryPort } from "../commands/types.js";
import type { NavItemId } from "../nav.js";
import {
  parseCustomerRows,
  unwrapQueryResult as unwrapCustomers,
  type CustomerRowView,
} from "./CustomersPage.js";
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
import { useScanFocus } from "./use-scan-focus.js";

export type CounterWorkbenchProps = Readonly<{
  queryClient: QueryPort;
  onNavigate: (id: NavItemId) => void;
  onOpenPickup: (orderId: string) => void;
  onOpenPickupLookup: (key: string) => void;
  /** Open 客户 with this lookup (and select the customer when known). */
  onOpenCustomer?: (query: string, customerId?: string) => void;
}>;

export function CounterWorkbench({
  queryClient,
  onNavigate,
  onOpenPickup,
  onOpenPickupLookup,
  onOpenCustomer,
}: CounterWorkbenchProps) {
  const toast = useToast();
  const [pickupKey, setPickupKey] = useState("");
  const [customerKey, setCustomerKey] = useState("");
  const [orders, setOrders] = useState<readonly OrderListRowView[]>([]);
  const [summary, setSummary] = useState<DaySummaryView | null>(null);
  const [customers, setCustomers] = useState<readonly CustomerRowView[] | null>(null);
  const [boardBusy, setBoardBusy] = useState(false);
  const [lookupBusy, setLookupBusy] = useState(false);
  const workbenchRef = useRef<HTMLElement | null>(null);
  const loadRef = useRef<() => Promise<void>>(async () => undefined);
  useScanFocus(workbenchRef, 'input[name="quick-pickup"]');

  const load = useCallback(async () => {
    setBoardBusy(true);
    try {
      const statsRes = await queryClient.execute<unknown>("stats.day.summary", {});
      if (!statsRes.ok) {
        setOrders([]);
        toast.push(statsRes.error.message ?? statsRes.error.code, "error");
        return;
      }
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
      if (ordersRes.ok) setOrders(parseOrderListRows(unwrapOrders(ordersRes.data)) ?? []);
      else toast.push(ordersRes.error.message ?? ordersRes.error.code, "error");
    } finally {
      setBoardBusy(false);
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
    if (lookupBusy) return;
    setLookupBusy(true);
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
      setLookupBusy(false);
    }
  }, [lookupBusy, onOpenPickup, onOpenPickupLookup, pickupKey, queryClient, toast]);

  const onCustomerSearch = useCallback(async () => {
    const key = customerKey.trim();
    if (key.length === 0) {
      onNavigate("customers");
      return;
    }
    setLookupBusy(true);
    try {
      const res = await queryClient.execute<unknown>("customer.search", { query: key, limit: 5 });
      if (!res.ok) {
        toast.push(res.error.message ?? res.error.code, "error");
        return;
      }
      setCustomers(parseCustomerRows(unwrapCustomers(res.data)) ?? []);
    } finally {
      setLookupBusy(false);
    }
  }, [customerKey, onNavigate, queryClient, toast]);

  return (
    <main ref={workbenchRef} className="ld-shell-main ld-workbench" id="main-content" tabIndex={-1}>
      <h1 className="ld-shell-main__title">工作台</h1>
      <p className="ld-shell-main__hint">扫码或输入票号、取件码即可取衣；看板按今日营业日统计。</p>
      <div className="ld-counter-grid ld-counter-grid--workbench">
        <section className="ld-counter-panel ld-workbench-pickup" aria-label="快捷取衣">
          <h2 className="ld-counter-panel__title">
            <Icon name="scan" size={18} />
            快捷取衣
          </h2>
          <div className="ld-workbench-search">
            <Input
              name="quick-pickup"
              className="ld-input--scan"
              label="票号 / 取件码 / 条码 / 手机号 / 姓名"
              value={pickupKey}
              onChange={(event) => setPickupKey(event.target.value)}
              hint="扫码枪扫描后自动回车查找"
              autoComplete="off"
              spellCheck={false}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void onPickupSearch();
                }
              }}
            />
            <Button
              variant="primary"
              size="lg"
              type="button"
              onClick={() => void onPickupSearch()}
              disabled={lookupBusy}
            >
              {lookupBusy ? "查找中…" : "进入取衣"}
              <Icon name="arrowRight" size={18} />
            </Button>
          </div>
          <details className="ld-workbench-numpad">
            <summary>触屏数字键盘</summary>
            <NumberPad value={pickupKey} onChange={setPickupKey} label="取件码数字键盘" />
          </details>
          <div className="ld-workbench-actions">
            <Button variant="secondary" type="button" onClick={() => onNavigate("receive")}>
              <Icon name="receive" size={18} />
              开单
            </Button>
            <Button variant="ghost" type="button" onClick={() => onNavigate("stats")}>
              日结与交班
            </Button>
          </div>
        </section>
        <section className="ld-counter-panel" aria-label="今日看板">
          <div className="ld-counter-panel__head">
            <h2 className="ld-counter-panel__title">
              <Icon name="stats" size={18} />
              今日看板
            </h2>
            <Button
              variant="ghost"
              size="sm"
              type="button"
              onClick={() => void load()}
              disabled={boardBusy}
            >
              <Icon name="refresh" size={16} />
              {boardBusy ? "刷新中…" : "刷新"}
            </Button>
          </div>
          <div className="ld-workbench-metrics" data-testid="counter-workbench-metrics">
            <Metric
              icon="receive"
              label="收衣"
              value={summary === null ? "—" : summary.order_count}
              unit="单"
              onOpen={() => onNavigate("stats")}
            />
            <Metric
              icon="shirt"
              label="衣物"
              value={summary === null ? "—" : summary.garment_count}
              unit="件"
              onOpen={() => onNavigate("stats")}
            />
            {summary?.real_income_cents !== undefined &&
            summary.performance_income_cents !== undefined ? (
              <>
                <Metric
                  icon="check"
                  label="今日实收"
                  value={<MoneyText fen={summary.real_income_cents} />}
                  onOpen={() => onNavigate("stats")}
                />
                <Metric
                  icon="stats"
                  label="营业额"
                  value={<MoneyText fen={summary.performance_income_cents} />}
                  onOpen={() => onNavigate("stats")}
                />
              </>
            ) : (
              <Metric
                icon="check"
                label="收款（退款前）"
                value={summary === null ? "—" : <MoneyText fen={summary.payment_cents} />}
                onOpen={() => onNavigate("stats")}
              />
            )}
            <Metric
              icon="alertCircle"
              label="欠款"
              value={summary === null ? "—" : <MoneyText fen={summary.balance_cents} />}
              onOpen={() => onNavigate("orders")}
            />
          </div>
          <p className="ld-shell-main__hint">
            {summary?.real_income_cents === undefined
              ? "含会员余额付款；欠款补缴和冲正请查看账目。"
              : "今日实收已扣除退款与冲正，含会员充值，与账目一致；营业额按开单结算，含会员余额付款。"}
          </p>
          <h3 className="ld-counter-panel__subtitle">今日待取</h3>
          <ul className="ld-workbench-orders" data-testid="counter-workbench-orders">
            {orders.length === 0 ? (
              <li className="ld-workbench-empty">
                <EmptyState
                  icon={<Icon name="check" size={24} />}
                  title="暂无待取订单"
                  description="今日开单后，待取衣物会出现在这里。"
                  actionLabel="去开单"
                  onAction={() => onNavigate("receive")}
                />
              </li>
            ) : (
              orders.map((order) => (
                <li key={order.order_id}>
                  <button
                    type="button"
                    className="ld-workbench-orders__row"
                    onClick={() => onOpenPickup(order.order_id)}
                  >
                    <span className="ld-workbench-orders__ticket">{order.ticket_no ?? "挂单"}</span>
                    <span className="ld-workbench-orders__sub">
                      {order.customer_name ?? "散客"}
                    </span>
                    <StatusBadge family="order" status={order.status} />
                  </button>
                </li>
              ))
            )}
          </ul>
        </section>
        <section className="ld-counter-panel" aria-label="顾客速查">
          <h2 className="ld-counter-panel__title">
            <Icon name="customers" size={18} />
            顾客速查
          </h2>
          <Input
            name="quick-customer"
            label="姓名或手机号"
            value={customerKey}
            onChange={(event) => setCustomerKey(event.target.value)}
            autoComplete="off"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
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
              disabled={lookupBusy}
            >
              <Icon name="search" size={16} />
              查客户
            </Button>
            <Button variant="ghost" type="button" onClick={() => onNavigate("customers")}>
              客户档案
            </Button>
          </div>
          <ul className="ld-workbench-customers">
            {customers === null ? (
              <li className="ld-workbench-empty">输入姓名或手机号后按 Enter 查找</li>
            ) : customers.length === 0 ? (
              <li className="ld-workbench-empty">没有匹配的客户</li>
            ) : (
              customers.map((customer) => (
                <li key={customer.customer_id}>
                  <button
                    type="button"
                    className="ld-workbench-customers__row"
                    onClick={() =>
                      onOpenCustomer === undefined
                        ? onNavigate("customers")
                        : onOpenCustomer(customerKey.trim(), customer.customer_id)
                    }
                  >
                    <span>{customer.name ?? "未命名客户"}</span>
                    <span className="ld-workbench-customers__sub">{customer.phone}</span>
                    <Icon name="chevronRight" size={16} />
                  </button>
                </li>
              ))
            )}
          </ul>
        </section>
      </div>
    </main>
  );
}

function Metric({
  icon,
  label,
  value,
  unit,
  onOpen,
}: Readonly<{
  icon: IconName;
  label: string;
  value: ReactNode;
  unit?: string;
  onOpen: () => void;
}>) {
  return (
    <button type="button" className="ld-workbench-metric" onClick={onOpen}>
      <span className="ld-workbench-metric__label">
        <Icon name={icon} size={16} />
        {label}
      </span>
      <strong className="ld-workbench-metric__value">
        {value}
        {unit === undefined ? null : <small>{unit}</small>}
      </strong>
    </button>
  );
}
