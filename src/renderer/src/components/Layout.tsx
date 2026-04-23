import { NavLink, useLocation, useOutlet } from "react-router-dom";
import {
  LayoutDashboard,
  ReceiptText,
  PackageCheck,
  Users,
  Settings,
  BarChart3,
  ListOrdered,
} from "lucide-react";
import { cn } from "@renderer/lib/utils";
import { AnimatePresence, motion } from "framer-motion";

const navItems = [
  { to: "/", icon: LayoutDashboard, label: "总览" },
  { to: "/receive", icon: ReceiptText, label: "收件登记" },
  { to: "/pickup", icon: PackageCheck, label: "取件查询" },
  { to: "/orders", icon: ListOrdered, label: "订单列表" },
  { to: "/customers", icon: Users, label: "客户管理" },
  { to: "/stats", icon: BarChart3, label: "统计报表" },
  { to: "/settings", icon: Settings, label: "系统设置" },
];

export default function Layout() {
  const location = useLocation();
  const outlet = useOutlet();

  return (
    <div className="relative flex h-screen overflow-hidden bg-[#f5f5f7] text-slate-950">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_22%_8%,rgba(0,113,227,0.18),transparent_30%),radial-gradient(circle_at_88%_6%,rgba(175,82,222,0.12),transparent_26%),linear-gradient(135deg,#fbfbfd_0%,#f5f5f7_42%,#edf2f8_100%)]" />
      <div className="pointer-events-none absolute left-[300px] top-20 h-48 w-48 rounded-full bg-sky-200/40 blur-3xl" />
      <div className="pointer-events-none absolute bottom-16 right-24 h-56 w-56 rounded-full bg-indigo-200/35 blur-3xl" />

      <aside className="relative z-10 flex w-[280px] flex-col border-r border-white/70 bg-white/62 shadow-[20px_0_70px_rgba(15,23,42,0.06)] backdrop-blur-2xl">
        <div className="p-6 pb-4">
          <div className="mb-8 flex gap-2">
            <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
            <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
            <span className="h-3 w-3 rounded-full bg-[#28c840]" />
          </div>
          <h1 className="text-[28px] font-semibold tracking-[-0.04em] text-[#0071e3]">
            宏发洗衣店
          </h1>
          <p className="mt-1 text-xs font-medium uppercase tracking-[0.24em] text-slate-400">
            柜台管理系统
          </p>
        </div>

        <nav className="flex-1 space-y-2 px-4">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "group flex items-center gap-3 rounded-[20px] px-4 py-3 text-[15px] font-semibold transition-all",
                  isActive
                    ? "bg-white/90 text-[#0071e3] shadow-[0_16px_36px_rgba(15,23,42,0.08)] ring-1 ring-white/80"
                    : "text-slate-500 hover:bg-white/60 hover:text-slate-950",
                )
              }
            >
              <item.icon
                className={cn(
                  "h-5 w-5 transition-colors group-hover:text-[#0071e3]",
                )}
              />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="p-4">
          <div className="flex items-center gap-3 rounded-[24px] border border-white/70 bg-white/72 p-3 shadow-[0_12px_30px_rgba(15,23,42,0.06)] backdrop-blur-xl">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#0071e3]/10 text-sm font-bold text-[#0071e3]">
              AD
            </div>
            <div>
              <p className="text-sm font-semibold">店长：周学胜</p>
              <p className="text-xs font-medium text-emerald-600">店长在线</p>
            </div>
          </div>
        </div>
      </aside>

      <main className="relative z-10 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl p-10">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: 18, filter: "blur(8px)" }}
              animate={{
                opacity: 1,
                y: 0,
                filter: "blur(0px)",
                transition: {
                  duration: 0.26,
                  ease: [0.22, 1, 0.36, 1],
                },
              }}
              exit={{
                opacity: 0,
                y: -12,
                filter: "blur(8px)",
                transition: {
                  duration: 0.18,
                  ease: [0.4, 0, 1, 1],
                },
              }}
            >
              {outlet}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}
