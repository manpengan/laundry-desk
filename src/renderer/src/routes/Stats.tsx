import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../components/ui/Card";
import { formatCurrency } from "@renderer/lib/utils";
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
  TrendingUp,
  Calendar,
  CreditCard,
  ShoppingBag,
  Download,
} from "lucide-react";
import { Button } from "../components/ui/Button";
import { Notice } from "../components/ui/Notice";

export default function Stats() {
  const [stats, setStats] = useState<any>(null);
  const [reportType, setReportType] = useState<"daily" | "monthly">("daily");
  const [chartData, setChartData] = useState<any[]>([]);
  const [overdueOrders, setOverdueOrders] = useState<any[]>([]);
  const [message, setMessage] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    window.api.orders.getStats().then((res: any) => {
      if (res.ok) setStats(res.data);
    });
    window.api.orders.getOverdue().then((res: any) => {
      if (res.ok) setOverdueOrders(res.data || []);
    });
  }, []);

  useEffect(() => {
    window.api.orders.getReport({ type: reportType }).then((res: any) => {
      if (res.ok) setChartData(res.data);
    });
  }, [reportType]);

  const handleExport = async () => {
    const res = await window.api.excel.exportOrders();
    if (res.ok && res.data) {
      setMessage(`导出成功: ${res.data}`);
    }
  };

  if (!stats)
    return (
      <div className="p-20 text-center text-slate-500">正在计算数据...</div>
    );

  return (
    <div className="space-y-8 pb-12">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-3xl font-bold tracking-tight">业务统计</h2>
          <p className="text-slate-500 mt-2">实时掌握店铺营收与经营动态。</p>
        </div>
        <Button onClick={handleExport}>
          <Download className="w-4 h-4 mr-2" /> 导出报表
        </Button>
      </div>

      {message && <Notice variant="success">{message}</Notice>}

      {/* 核心指标 */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <Card className="border-none shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              今日收入
            </CardTitle>
            <CreditCard className="w-4 h-4 text-blue-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatCurrency(stats.todayIncome)}
            </div>
            <p className="text-xs text-slate-400 mt-1">
              共 {stats.todayCount} 笔订单
            </p>
          </CardContent>
        </Card>
        <Card className="border-none shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              本月收入
            </CardTitle>
            <Calendar className="w-4 h-4 text-green-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatCurrency(stats.monthIncome)}
            </div>
            <p className="text-xs text-slate-400 mt-1">
              本月累计 {stats.monthCount} 笔
            </p>
          </CardContent>
        </Card>
        <Card className="border-none shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              平均客单价
            </CardTitle>
            <TrendingUp className="w-4 h-4 text-orange-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatCurrency(
                stats.monthCount > 0 ? stats.monthIncome / stats.monthCount : 0,
              )}
            </div>
          </CardContent>
        </Card>
        <Card className="border-none shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-slate-500">
              待取衣物
            </CardTitle>
            <ShoppingBag className="w-4 h-4 text-purple-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.pendingCount} 件</div>
          </CardContent>
        </Card>
      </div>

      {/* 图表展示 */}
      <div className="grid gap-6 md:grid-cols-2">
        <Card className="border-none shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-lg">
              {reportType === "daily"
                ? "近 30 日收入趋势"
                : "近 12 个月收入趋势"}{" "}
              (元)
            </CardTitle>
            <div className="flex bg-slate-100 p-1 rounded-lg text-xs font-medium">
              <button
                type="button"
                className={`px-3 py-1.5 rounded-md transition-colors ${
                  reportType === "daily"
                    ? "bg-white text-slate-800 shadow-sm"
                    : "text-slate-500 hover:text-slate-800"
                }`}
                onClick={() => setReportType("daily")}
              >
                按日
              </button>
              <button
                type="button"
                className={`px-3 py-1.5 rounded-md transition-colors ${
                  reportType === "monthly"
                    ? "bg-white text-slate-800 shadow-sm"
                    : "text-slate-500 hover:text-slate-800"
                }`}
                onClick={() => setReportType("monthly")}
              >
                按月
              </button>
            </div>
          </CardHeader>
          <CardContent className="h-[300px] pt-4">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="#f1f5f9"
                />
                <XAxis
                  dataKey="date"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 12, fill: "#94a3b8" }}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 12, fill: "#94a3b8" }}
                />
                <Tooltip
                  cursor={{ fill: "#f8fafc" }}
                  contentStyle={{
                    borderRadius: "12px",
                    border: "none",
                    boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
                  }}
                />
                <Bar dataKey="income" fill="#2563eb" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card className="border-none shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-lg">
              {reportType === "daily"
                ? "近 30 日收件量趋势"
                : "近 12 个月收件量趋势"}{" "}
              (件)
            </CardTitle>
            <div className="flex bg-slate-100 p-1 rounded-lg text-xs font-medium invisible">
              {/* placeholder to align headers */}
              <span className="px-3 py-1.5">Align</span>
            </div>
          </CardHeader>
          <CardContent className="h-[300px] pt-4">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <CartesianGrid
                  strokeDasharray="3 3"
                  vertical={false}
                  stroke="#f1f5f9"
                />
                <XAxis
                  dataKey="date"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 12, fill: "#94a3b8" }}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fontSize: 12, fill: "#94a3b8" }}
                />
                <Tooltip
                  contentStyle={{
                    borderRadius: "12px",
                    border: "none",
                    boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="count"
                  stroke="#2563eb"
                  strokeWidth={3}
                  dot={{ r: 4, fill: "#2563eb" }}
                  activeDot={{ r: 6 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* 逾期未取订单列表 */}
      <Card className="border-none shadow-sm mt-6">
        <CardHeader>
          <CardTitle className="text-lg flex items-center justify-between">
            <span>逾期未取订单列表</span>
            <span className="text-sm font-normal text-slate-400">
              共 {overdueOrders.length} 笔订单逾期未取
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left text-slate-500">
              <thead className="text-xs text-slate-400 uppercase bg-slate-50/50">
                <tr>
                  <th className="px-4 py-3 rounded-l-xl">订单号</th>
                  <th className="px-4 py-3">客户</th>
                  <th className="px-4 py-3">应取日期</th>
                  <th className="px-4 py-3">金额</th>
                  <th className="px-4 py-3">未结欠款</th>
                  <th className="px-4 py-3 rounded-r-xl text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {overdueOrders.map((order) => {
                  const balance = order.totalAmount - order.paidAmount;
                  return (
                    <tr key={order.id} className="hover:bg-slate-50/50">
                      <td className="px-4 py-3 font-semibold text-slate-700">
                        {order.orderNo}
                      </td>
                      <td className="px-4 py-3">
                        {order.customer?.name} ({order.customer?.phone})
                      </td>
                      <td className="px-4 py-3 text-red-500 font-medium">
                        {order.expectedPickupDate
                          ? new Date(
                              order.expectedPickupDate,
                            ).toLocaleDateString("zh-CN",{month:"2-digit",day:"2-digit"})
                          : "-"}
                      </td>
                      <td className="px-4 py-3">
                        {formatCurrency(order.totalAmount)}
                      </td>
                      <td className="px-4 py-3">
                        {balance > 0 ? (
                          <span className="text-red-500 font-semibold">
                            {formatCurrency(balance)}
                          </span>
                        ) : (
                          <span className="text-green-600 font-medium">
                            已结清
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
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
                      className="px-4 py-8 text-center text-slate-400"
                    >
                      暂无逾期未取订单
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
