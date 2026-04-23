import { useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/Card";
import { cn } from "@renderer/lib/utils";
import {
  AlertCircle,
  ArrowRight,
  Clock,
  Coins,
  PackageCheck,
  ReceiptText,
  Sparkles,
} from "lucide-react";
import { Link } from "react-router-dom";
import type { StatsDto } from "@shared/index";
import { motion } from "framer-motion";
import { formatCurrency } from "@renderer/lib/utils";

export default function Home() {
  const [stats, setStats] = useState<StatsDto | null>(null);

  useEffect(() => {
    window.api.orders.getStats().then((response) => {
      if (response.ok) setStats(response.data);
    });
  }, []);

  const dashboardCards = useMemo(
    () => [
      {
        label: "今日收件",
        value: stats?.todayCount ?? 0,
        icon: ReceiptText,
        color: "text-blue-600",
        bg: "bg-blue-50",
      },
      {
        label: "待取件",
        value: stats?.pendingCount ?? 0,
        icon: PackageCheck,
        color: "text-green-600",
        bg: "bg-green-50",
      },
      {
        label: "逾期未取",
        value: stats?.overdueCount ?? 0,
        icon: AlertCircle,
        color: "text-red-600",
        bg: "bg-red-50",
      },
      {
        label: "预计今日交付",
        value: stats?.dueTodayCount ?? 0,
        icon: Clock,
        color: "text-orange-600",
        bg: "bg-orange-50",
      },
    ],
    [stats],
  );

  const todayLabel = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(new Date());

  return (
    <div className="space-y-9">
      <div className="grid gap-6 xl:grid-cols-[1.3fr_0.7fr]">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-col gap-5"
        >
          <div className="inline-flex w-fit items-center gap-2 rounded-full border border-white/70 bg-white/70 px-4 py-2 text-sm font-semibold text-slate-600 shadow-[0_10px_30px_rgba(15,23,42,0.06)] backdrop-blur-xl">
            <Sparkles className="h-4 w-4 text-[#0071e3]" />
            今日营业中
          </div>
          <div>
            <h2 className="max-w-3xl text-[56px] font-semibold leading-[0.98] tracking-[-0.06em] text-slate-950">
              你好，周学胜
            </h2>
            <p className="mt-4 text-xl font-medium text-slate-500">
              今天是 {todayLabel}，宏发洗衣店运行正常。
            </p>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, delay: 0.05, ease: [0.22, 1, 0.36, 1] }}
        >
          <Card className="overflow-hidden bg-[linear-gradient(140deg,rgba(255,255,255,0.92),rgba(243,247,255,0.82))]">
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Coins className="h-5 w-5 text-[#0071e3]" />
                经营概览
              </CardTitle>
              <CardDescription>
                首页数据已切到实时统计，不再使用占位数字。
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-3 xl:grid-cols-1">
              <div className="rounded-[22px] border border-white/80 bg-white/80 p-4">
                <div className="text-sm font-medium text-slate-500">
                  今日实收
                </div>
                <div className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-slate-950">
                  {formatCurrency(stats?.todayIncome ?? 0)}
                </div>
              </div>
              <div className="rounded-[22px] border border-white/80 bg-white/80 p-4">
                <div className="text-sm font-medium text-slate-500">
                  本月实收
                </div>
                <div className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-slate-950">
                  {formatCurrency(stats?.monthIncome ?? 0)}
                </div>
              </div>
              <div className="rounded-[22px] border border-white/80 bg-white/80 p-4">
                <div className="text-sm font-medium text-slate-500">
                  本月收件
                </div>
                <div className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-slate-950">
                  {(stats?.monthCount ?? 0).toLocaleString("zh-CN")}
                </div>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        {dashboardCards.map((stat, index) => (
          <motion.div
            key={stat.label}
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{
              duration: 0.3,
              delay: 0.08 + index * 0.05,
              ease: [0.22, 1, 0.36, 1],
            }}
          >
            <Card className="group overflow-hidden transition-all hover:-translate-y-1 hover:bg-white/95">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-semibold text-slate-500">
                  {stat.label}
                </CardTitle>
                <div
                  className={cn(
                    "rounded-2xl p-3 transition-all group-hover:scale-105",
                    stat.bg,
                    stat.color,
                  )}
                >
                  <stat.icon className="h-5 w-5" />
                </div>
              </CardHeader>
              <CardContent>
                <div className="text-[42px] font-semibold tracking-[-0.05em]">
                  {stat.value.toLocaleString("zh-CN")}
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, delay: 0.28, ease: [0.22, 1, 0.36, 1] }}
        >
          <Card className="overflow-hidden transition-all hover:-translate-y-1 hover:bg-white/95">
            <CardHeader>
              <CardTitle>快速收件</CardTitle>
              <CardDescription>
                录入客户、物品与付款信息，生成取件码。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <p className="text-base font-medium leading-7 text-slate-500">
                点击进入收件流程，支持自动识别回头客。
              </p>
              <Link
                className="inline-flex items-center gap-2 text-sm font-semibold text-[#0071e3]"
                to="/receive"
              >
                开始收件
                <ArrowRight className="h-4 w-4" />
              </Link>
            </CardContent>
          </Card>
        </motion.div>
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.28, delay: 0.34, ease: [0.22, 1, 0.36, 1] }}
        >
          <Card className="overflow-hidden transition-all hover:-translate-y-1 hover:bg-white/95">
            <CardHeader>
              <CardTitle>快速取件</CardTitle>
              <CardDescription>
                输入取件码、订单号或手机号，实时完成出库。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <p className="text-base font-medium leading-7 text-slate-500">
                报取件码或手机号快速结账取走衣物。
              </p>
              <Link
                className="inline-flex items-center gap-2 text-sm font-semibold text-[#0071e3]"
                to="/pickup"
              >
                查询取件
                <ArrowRight className="h-4 w-4" />
              </Link>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}
