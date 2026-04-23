import { useEffect, useState } from "react";
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
  const [message, setMessage] = useState("");

  useEffect(() => {
    window.api.orders.getStats().then((res: any) => {
      if (res.ok) setStats(res.data);
    });
  }, []);

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
    <div className="space-y-8">
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
              收件总量
            </CardTitle>
            <ShoppingBag className="w-4 h-4 text-purple-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats.monthCount}</div>
          </CardContent>
        </Card>
      </div>

      {/* 图表展示 */}
      <div className="grid gap-6 md:grid-cols-2">
        <Card className="border-none shadow-sm">
          <CardHeader>
            <CardTitle className="text-lg">近 7 日收入趋势 (元)</CardTitle>
          </CardHeader>
          <CardContent className="h-[300px] pt-4">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.chartData}>
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
          <CardHeader>
            <CardTitle className="text-lg">近 7 日收件量趋势 (件)</CardTitle>
          </CardHeader>
          <CardContent className="h-[300px] pt-4">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={stats.chartData}>
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
    </div>
  );
}
