import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ReceiptText, PackageSearch, Clock3, AlertTriangle, ArrowUpRight, Wallet,
} from "lucide-react";

interface Stats {
  todayCount: number;
  todayIncome: number;
  pendingCount: number;
  overdueCount: number;
  monthIncome: number;
}
const yuan = (c: number) => (c / 100).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export default function Home() {
  const [d, setD] = useState<Stats | null>(null);
  const [now] = useState(() => new Date());
  const nav = useNavigate();

  useEffect(() => {
    let off = false;
    window.api.orders.getStats().then((r) => { if (!off && r.ok) setD(r.data); }).catch(() => {});
    return () => { off = true; };
  }, []);

  const h = now.getHours();
  const hi = h < 6 ? "凌晨好" : h < 12 ? "上午好" : h < 14 ? "中午好" : h < 18 ? "下午好" : "晚上好";
  const dateStr = now.toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "long" });

  const metrics = [
    { label: "今日收件", value: d ? String(d.todayCount) : "—", unit: "单", icon: ReceiptText, bg: "var(--lg-info-bg)", ink: "var(--lg-info-ink)", to: "/receive" },
    { label: "待取件", value: d ? String(d.pendingCount) : "—", unit: "单", icon: PackageSearch, bg: "var(--lg-ok-bg)", ink: "var(--lg-ok-ink)", to: "/pickup" },
    { label: "逾期未取", value: d ? String(d.overdueCount) : "—", unit: "单", icon: AlertTriangle, bg: "var(--lg-late-bg)", ink: "var(--lg-late-ink)", to: "/orders" },
    { label: "本月实收", value: d ? `¥${yuan(d.monthIncome)}` : "—", icon: Wallet, bg: "var(--lg-warn-bg)", ink: "var(--lg-warn-ink)", to: "/stats" },
  ];

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-[28px] font-bold leading-none tracking-[-0.03em]">{hi}，周店长</h2>
          <p className="mt-2 text-[13.5px] text-[var(--lg-ink2)]">{dateStr} · 宏发洗衣店运行正常</p>
        </div>
        <button
          onClick={() => nav("/receive")}
          className="lg-pressable inline-flex items-center gap-2 rounded-[13px] bg-gradient-to-b from-[var(--lg-accent2)] to-[var(--lg-accent)] px-5 py-3 text-[14px] font-semibold text-white shadow-[0_12px_28px_-10px_var(--lg-accent-soft),inset_0_1px_0_rgba(255,255,255,0.35)]"
        >
          <ReceiptText className="h-[18px] w-[18px]" strokeWidth={2.2} />新建收件
        </button>
      </header>

      {/* 营业额主卡 */}
      <motion.div
        initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        className="lg-card lg-spec relative overflow-hidden rounded-[22px]"
      >
        <div className="flex flex-wrap items-center justify-between gap-6 p-7">
          <div>
            <div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--lg-ink2)]">
              <span className="flex h-7 w-7 items-center justify-center rounded-[9px]" style={{ background: "var(--lg-info-bg)", color: "var(--lg-info-ink)" }}>
                <ArrowUpRight className="h-4 w-4" strokeWidth={2.4} />
              </span>
              今日营业额
            </div>
            <div className="mt-3.5 flex items-baseline gap-1 leading-none" style={{ fontVariantNumeric: "tabular-nums" }}>
              <span className="text-[26px] font-semibold text-[var(--lg-ink2)]">¥</span>
              <span className="text-[48px] font-bold tracking-[-0.04em]">{d ? yuan(d.todayIncome) : "—"}</span>
            </div>
          </div>
          <div className="flex items-center gap-2.5 rounded-[14px] px-4 py-3" style={{ background: "var(--lg-leaf)" }}>
            <Clock3 className="h-[18px] w-[18px] text-[var(--lg-ink3)]" strokeWidth={2} />
            <div className="leading-tight">
              <p className="text-[12px] text-[var(--lg-ink3)]">本月累计</p>
              <p className="text-[16px] font-bold tracking-[-0.02em]" style={{ fontVariantNumeric: "tabular-nums" }}>¥{d ? yuan(d.monthIncome) : "—"}</p>
            </div>
          </div>
        </div>
      </motion.div>

      {/* 指标卡 */}
      <div className="grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        {metrics.map((m, i) => (
          <motion.button
            key={m.label}
            onClick={() => nav(m.to)}
            initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.06 + i * 0.05, duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            className="lg-card lg-spec lg-pressable rounded-[18px] p-5 text-left"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-[11px]" style={{ background: m.bg, color: m.ink }}>
              <m.icon className="h-[18px] w-[18px]" strokeWidth={2.2} />
            </span>
            <div className="mt-3.5 leading-none" style={{ fontVariantNumeric: "tabular-nums" }}>
              <span className="text-[27px] font-bold tracking-[-0.03em]">{m.value}</span>
              {m.unit && <span className="ml-1 text-[14px] font-semibold text-[var(--lg-ink2)]">{m.unit}</span>}
            </div>
            <p className="mt-2 text-[13px] font-medium text-[var(--lg-ink2)]">{m.label}</p>
          </motion.button>
        ))}
      </div>
    </div>
  );
}
