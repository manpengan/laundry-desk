import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ReceiptText } from "lucide-react";
import type { CustomerDto, OrderWithDetailsDto, StatsDto } from "@shared/index";
import {
  buildView,
  itemSummary,
  orderStatus,
  periodLabel,
  useCountUp,
  yuan,
  type Period,
} from "@renderer/components/home/homeData";
import { Sparkline } from "@renderer/components/home/Sparkline";
import { PickupKeypad } from "@renderer/components/home/PickupKeypad";

export default function Home() {
  const nav = useNavigate();
  const [period, setPeriod] = useState<Period>("today");
  const [stats, setStats] = useState<StatsDto | null>(null);
  const [orders, setOrders] = useState<OrderWithDetailsDto[]>([]);
  const [customers, setCustomers] = useState<CustomerDto[]>([]);
  const segRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState({ x: 4, w: 0 });

  useEffect(() => {
    let off = false;
    void window.api.orders.getStats().then((r) => {
      if (!off && r.ok) setStats(r.data);
    });
    void window.api.orders.findAll({ limit: 60 }).then((r) => {
      if (!off && r.ok) setOrders(r.data);
    });
    void window.api.customers.findAll().then((r) => {
      if (!off && r.ok) setCustomers(r.data);
    });
    return () => {
      off = true;
    };
  }, []);

  useEffect(() => {
    const el = segRef.current?.querySelector<HTMLButtonElement>(
      `button[data-p="${period}"]`,
    );
    if (el) setThumb({ x: el.offsetLeft - 4, w: el.offsetWidth });
  }, [period, stats]);

  const view = useMemo(
    () => (stats ? buildView(period, stats, orders, customers) : null),
    [period, stats, orders, customers],
  );
  const incomeAnim = useCountUp(view?.income ?? 0);
  const countAnim = useCountUp(view?.count ?? 0);
  const pendingAnim = useCountUp(stats?.pendingCount ?? 0);
  const newcAnim = useCountUp(view?.newCustomers ?? 0);
  const returning =
    customers.length > 0
      ? Math.round(
          (customers.filter((c) => c.totalOrders >= 2).length /
            customers.length) *
            100,
        )
      : null;
  const spark = useMemo(
    () => (stats ? stats.chartData.slice(-7).map((r) => r.income) : []),
    [stats],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--lg-ink3)]">
            Dashboard
          </p>
          <h2 className="mt-1 text-[24px] font-bold leading-none tracking-[-0.02em]">
            {periodLabel[period]}总览
          </h2>
        </div>
        <div className="flex items-center gap-3">
          <div
            className="lg-seg"
            ref={segRef}
            role="tablist"
            aria-label="统计周期"
          >
            <span
              className="lg-seg-thumb"
              style={{ transform: `translateX(${thumb.x}px)`, width: thumb.w }}
            />
            {(["today", "week", "month"] as Period[]).map((p) => (
              <button
                key={p}
                data-p={p}
                type="button"
                className={period === p ? "on" : ""}
                onClick={() => setPeriod(p)}
              >
                {periodLabel[p]}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => nav("/receive")}
            className="lg-pressable inline-flex items-center gap-2 rounded-full bg-gradient-to-b from-[var(--lg-accent2)] to-[var(--lg-accent)] px-5 py-[11px] text-[14px] font-semibold text-[var(--lg-accent-ink)] shadow-[0_14px_34px_var(--lg-accent-soft),inset_0_1px_0_rgba(255,255,255,0.45)]"
          >
            <ReceiptText className="h-[17px] w-[17px]" strokeWidth={2.2} />
            收件登记
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3.5 xl:grid-cols-4">
        <div className="lg-card lg-spec rounded-[20px] p-4 pb-3">
          <div className="flex items-center justify-between text-[12px] font-semibold text-[var(--lg-ink2)]">
            营业额
            {view?.chip && (
              <span
                className={`lg-pill ${view.chip.startsWith("+") ? "ok" : "late"}`}
              >
                {view.chip}
              </span>
            )}
          </div>
          <div
            className="mt-2 leading-none"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            <span className="mr-0.5 text-[17px] font-semibold text-[var(--lg-ink2)]">
              ¥
            </span>
            <span className="text-[30px] font-bold tracking-[-0.03em]">
              {yuan(Math.round(incomeAnim))}
            </span>
          </div>
          <Sparkline points={spark} />
        </div>

        <div className="lg-card lg-spec rounded-[20px] p-4">
          <div className="text-[12px] font-semibold text-[var(--lg-ink2)]">
            收件单数
          </div>
          <div
            className="mt-2 leading-none"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            <span className="text-[30px] font-bold tracking-[-0.03em]">
              {Math.round(countAnim)}
            </span>
            <span className="ml-1 text-[15px] font-semibold text-[var(--lg-ink2)]">
              单
            </span>
          </div>
          <p className="mt-2.5 text-[12px] text-[var(--lg-ink3)]">
            共 {view?.pieces ?? "—"} 件衣物
          </p>
        </div>

        <div className="lg-card lg-spec rounded-[20px] p-4">
          <div className="flex items-center justify-between text-[12px] font-semibold text-[var(--lg-ink2)]">
            待取件
            {stats && stats.overdueCount > 0 && (
              <span className="lg-pill late">逾期 {stats.overdueCount}</span>
            )}
          </div>
          <div
            className="mt-2 leading-none"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            <span className="text-[30px] font-bold tracking-[-0.03em]">
              {Math.round(pendingAnim)}
            </span>
            <span className="ml-1 text-[15px] font-semibold text-[var(--lg-ink2)]">
              单
            </span>
          </div>
          <p className="mt-2.5 text-[12px] text-[var(--lg-ink3)]">
            今日应交付 {stats?.dueTodayCount ?? "—"} 单
          </p>
        </div>

        <div className="lg-card lg-spec rounded-[20px] p-4">
          <div className="text-[12px] font-semibold text-[var(--lg-ink2)]">
            新客
          </div>
          <div
            className="mt-2 leading-none"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            <span className="text-[30px] font-bold tracking-[-0.03em]">
              {Math.round(newcAnim)}
            </span>
            <span className="ml-1 text-[15px] font-semibold text-[var(--lg-ink2)]">
              位
            </span>
          </div>
          <p className="mt-2.5 text-[12px] text-[var(--lg-ink3)]">
            {returning !== null ? `回头率 ${returning}%` : "暂无客户数据"}
          </p>
        </div>
      </div>

      <div className="grid items-start gap-3.5 xl:grid-cols-[1.65fr_1fr]">
        <div className="lg-card lg-spec rounded-[22px]">
          <div className="flex items-center justify-between px-5 pb-1 pt-4">
            <h3 className="text-[16px] font-semibold tracking-[-0.01em]">
              最近订单
            </h3>
            <button
              type="button"
              onClick={() => nav("/orders")}
              className="text-[13px] font-semibold text-[var(--lg-accent)]"
            >
              全部订单 ›
            </button>
          </div>
          <div className="flex flex-col p-2">
            {orders.slice(0, 5).map((o) => {
              const st = orderStatus(o);
              return (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => nav(`/orders/${o.id}`)}
                  className="lg-pressable grid grid-cols-[1.2fr_1.4fr_auto_auto] items-center gap-3 rounded-[15px] px-3 py-2.5 text-left transition-colors hover:bg-[var(--lg-leaf-hover)]"
                >
                  <span className="min-w-0">
                    <span
                      className="block text-[13px] font-bold"
                      style={{ fontVariantNumeric: "tabular-nums" }}
                    >
                      {o.orderNo}
                    </span>
                    <span className="block truncate text-[11px] font-semibold text-[var(--lg-ink3)]">
                      {o.customer?.name ?? "散客"}
                    </span>
                  </span>
                  <span className="truncate text-[13px] text-[var(--lg-ink2)]">
                    {itemSummary(o)}
                  </span>
                  <span
                    className="text-[14px] font-bold"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    ¥ {yuan(o.totalAmount)}
                  </span>
                  <span className={`lg-pill ${st.cls} justify-self-end`}>
                    {st.text}
                  </span>
                </button>
              );
            })}
            {orders.length === 0 && (
              <p className="px-3 py-8 text-center text-[13px] text-[var(--lg-ink3)]">
                暂无订单，点击右上角「收件登记」开单
              </p>
            )}
          </div>
        </div>

        <PickupKeypad />
      </div>
    </div>
  );
}
