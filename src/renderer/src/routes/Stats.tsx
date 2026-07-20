import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
} from "recharts";
import {
  Download,
  TrendingUp,
  Calendar,
  CreditCard,
  ShoppingBag,
} from "lucide-react";
import type {
  OrderWithDetailsDto,
  ReportDataDto,
  StatsDto,
} from "@shared/index";
import { Button } from "../components/ui/Button";
import { Notice } from "../components/ui/Notice";
import { formatCurrency } from "@renderer/lib/utils";

/* Recharts 渲染 SVG 属性不解析 var()，运行时读 token 并监听主题切换 */
function useChartColors() {
  const read = () => {
    const cs = getComputedStyle(document.documentElement);
    const v = (name: string): string => cs.getPropertyValue(name).trim();
    return {
      accent: v("--lg-accent"),
      ink3: v("--lg-ink3"),
      hair: v("--lg-hair"),
      leaf: v("--lg-leaf"),
    };
  };
  const [colors, setColors] = useState(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setColors(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return colors;
}

const tooltipStyle = {
  borderRadius: "14px",
  border: "1px solid var(--lg-hair)",
  background: "var(--lg-glass-hi)",
  backdropFilter: "blur(20px) saturate(1.6)",
  boxShadow: "var(--lg-shadow-sm)",
  color: "var(--lg-ink)",
  fontSize: "12.5px",
};

const metricCards = (stats: StatsDto) => [
  {
    label: "今日收入",
    value: formatCurrency(stats.todayIncome),
    foot: `共 ${stats.todayCount} 笔订单`,
    icon: CreditCard,
    bg: "var(--lg-busy-bg)",
    ink: "var(--lg-busy-ink)",
  },
  {
    label: "本月收入",
    value: formatCurrency(stats.monthIncome),
    foot: `本月累计 ${stats.monthCount} 笔`,
    icon: Calendar,
    bg: "var(--lg-ok-bg)",
    ink: "var(--lg-ok-ink)",
  },
  {
    label: "平均客单价",
    value: formatCurrency(
      stats.monthCount > 0 ? stats.monthIncome / stats.monthCount : 0,
    ),
    foot: "按本月订单折算",
    icon: TrendingUp,
    bg: "var(--lg-warn-bg)",
    ink: "var(--lg-warn-ink)",
  },
  {
    label: "待取衣物",
    value: `${stats.pendingCount} 件`,
    foot: `今日应交付 ${stats.dueTodayCount} 单`,
    icon: ShoppingBag,
    bg: "var(--lg-late-bg)",
    ink: "var(--lg-late-ink)",
  },
];

export default function Stats() {
  const [stats, setStats] = useState<StatsDto | null>(null);
  const [reportType, setReportType] = useState<"daily" | "monthly">("daily");
  const [chartData, setChartData] = useState<ReportDataDto[]>([]);
  const [overdueOrders, setOverdueOrders] = useState<OrderWithDetailsDto[]>([]);
  const [message, setMessage] = useState("");
  const navigate = useNavigate();
  const colors = useChartColors();

  useEffect(() => {
    void window.api.orders.getStats().then((res) => {
      if (res.ok) setStats(res.data);
    });
    void window.api.orders.getOverdue().then((res) => {
      if (res.ok) setOverdueOrders(res.data ?? []);
    });
  }, []);

  useEffect(() => {
    void window.api.orders.getReport({ type: reportType }).then((res) => {
      if (res.ok) setChartData(res.data);
    });
  }, [reportType]);

  const handleExport = async (): Promise<void> => {
    const res = await window.api.excel.exportOrders();
    if (res.ok && res.data) setMessage(`导出成功: ${res.data}`);
    else if (!res.ok) setMessage(`导出失败: ${res.error.message}`);
  };

  if (!stats) {
    return (
      <div className="p-20 text-center text-[13.5px] text-[var(--lg-ink3)]">
        正在计算数据...
      </div>
    );
  }

  const axisTick = { fontSize: 12, fill: colors.ink3 };

  return (
    <div className="space-y-4 pb-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-[var(--lg-ink3)]">
            Stats
          </p>
          <h2 className="mt-1 text-[24px] font-bold leading-none tracking-[-0.02em]">
            统计报表
          </h2>
        </div>
        <Button onClick={() => void handleExport()}>
          <Download className="mr-2 h-4 w-4" /> 导出报表
        </Button>
      </div>

      {message && <Notice variant="success">{message}</Notice>}

      <div className="grid grid-cols-2 gap-3.5 xl:grid-cols-4">
        {metricCards(stats).map((m) => (
          <div key={m.label} className="lg-card lg-spec rounded-[20px] p-4">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-semibold text-[var(--lg-ink2)]">
                {m.label}
              </span>
              <span
                className="flex h-8 w-8 items-center justify-center rounded-[10px]"
                style={{ background: m.bg, color: m.ink }}
              >
                <m.icon className="h-4 w-4" strokeWidth={2.2} />
              </span>
            </div>
            <div
              className="mt-2 text-[24px] font-bold leading-none tracking-[-0.03em]"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {m.value}
            </div>
            <p className="mt-2 text-[12px] text-[var(--lg-ink3)]">{m.foot}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-3.5 xl:grid-cols-2">
        <div className="lg-card lg-spec rounded-[22px]">
          <div className="flex items-center justify-between px-5 pb-1 pt-4">
            <h3 className="text-[15px] font-semibold">
              {reportType === "daily"
                ? "近 30 日收入趋势"
                : "近 12 个月收入趋势"}
              （元）
            </h3>
            <div className="lg-seg">
              <button
                type="button"
                className={reportType === "daily" ? "on" : ""}
                onClick={() => setReportType("daily")}
              >
                按日
              </button>
              <button
                type="button"
                className={reportType === "monthly" ? "on" : ""}
                onClick={() => setReportType("monthly")}
              >
                按月
              </button>
            </div>
          </div>
          <div className="h-[280px] p-4 pt-2">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke={colors.hair}
                />
                <XAxis
                  dataKey="date"
                  axisLine={false}
                  tickLine={false}
                  tick={axisTick}
                />
                <YAxis axisLine={false} tickLine={false} tick={axisTick} />
                <Tooltip
                  cursor={{ fill: colors.leaf }}
                  contentStyle={tooltipStyle}
                />
                <Bar
                  dataKey="income"
                  fill={colors.accent}
                  radius={[6, 6, 0, 0]}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="lg-card lg-spec rounded-[22px]">
          <div className="flex items-center justify-between px-5 pb-1 pt-4">
            <h3 className="text-[15px] font-semibold">
              {reportType === "daily"
                ? "近 30 日收件量趋势"
                : "近 12 个月收件量趋势"}
              （件）
            </h3>
          </div>
          <div className="h-[280px] p-4 pt-2">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke={colors.hair}
                />
                <XAxis
                  dataKey="date"
                  axisLine={false}
                  tickLine={false}
                  tick={axisTick}
                />
                <YAxis axisLine={false} tickLine={false} tick={axisTick} />
                <Tooltip contentStyle={tooltipStyle} />
                <Line
                  type="monotone"
                  dataKey="count"
                  stroke={colors.accent}
                  strokeWidth={2.5}
                  dot={{ r: 3.5, fill: colors.accent, strokeWidth: 0 }}
                  activeDot={{ r: 5.5 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="lg-card lg-spec rounded-[22px]">
        <div className="flex items-center justify-between px-5 pb-1 pt-4">
          <h3 className="text-[15px] font-semibold">逾期未取订单</h3>
          <span className="text-[12px] text-[var(--lg-ink3)]">
            共 {overdueOrders.length} 笔
          </span>
        </div>
        <div className="overflow-x-auto p-3 pt-1">
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr className="text-[11.5px] font-bold uppercase tracking-wide text-[var(--lg-ink3)]">
                <th className="px-3 py-2.5">订单号</th>
                <th className="px-3 py-2.5">客户</th>
                <th className="px-3 py-2.5">应取日期</th>
                <th className="px-3 py-2.5">金额</th>
                <th className="px-3 py-2.5">未结欠款</th>
                <th className="px-3 py-2.5 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {overdueOrders.map((order) => {
                const balance = order.totalAmount - order.paidAmount;
                return (
                  <tr
                    key={order.id}
                    className="rounded-[12px] transition-colors hover:bg-[var(--lg-leaf-hover)]"
                  >
                    <td
                      className="px-3 py-2.5 font-bold"
                      style={{ fontVariantNumeric: "tabular-nums" }}
                    >
                      {order.orderNo}
                    </td>
                    <td className="px-3 py-2.5 text-[var(--lg-ink2)]">
                      {order.customer?.name}（{order.customer?.phone}）
                    </td>
                    <td className="px-3 py-2.5 font-semibold text-[var(--lg-late-ink)]">
                      {order.expectedPickupDate
                        ? new Date(order.expectedPickupDate).toLocaleDateString(
                            "zh-CN",
                            { month: "2-digit", day: "2-digit" },
                          )
                        : "—"}
                    </td>
                    <td
                      className="px-3 py-2.5"
                      style={{ fontVariantNumeric: "tabular-nums" }}
                    >
                      {formatCurrency(order.totalAmount)}
                    </td>
                    <td className="px-3 py-2.5">
                      {balance > 0 ? (
                        <span className="lg-pill late">
                          {formatCurrency(balance)}
                        </span>
                      ) : (
                        <span className="lg-pill ok">已结清</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => navigate(`/orders/${order.id}`)}
                      >
                        详情
                      </Button>
                    </td>
                  </tr>
                );
              })}
              {overdueOrders.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-8 text-center text-[var(--lg-ink3)]"
                  >
                    暂无逾期未取订单
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
