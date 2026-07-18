import { NavLink, useLocation, useOutlet } from "react-router-dom";
import { useEffect, useState } from "react";
import {
  LayoutGrid, ReceiptText, PackageSearch, ListChecks, Users2,
  BarChart3, Settings2, Sun, Moon, Shirt,
} from "lucide-react";
import { cn } from "@renderer/lib/utils";
import { AnimatePresence, motion } from "framer-motion";

const nav = [
  { to: "/", icon: LayoutGrid, label: "总览" },
  { to: "/receive", icon: ReceiptText, label: "收件登记" },
  { to: "/pickup", icon: PackageSearch, label: "取件查询" },
  { to: "/orders", icon: ListChecks, label: "订单列表" },
  { to: "/customers", icon: Users2, label: "客户管理" },
  { to: "/stats", icon: BarChart3, label: "统计报表" },
  { to: "/settings", icon: Settings2, label: "系统设置" },
];

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const s = document.documentElement.dataset.theme;
    if (s === "light" || s === "dark") return s;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  return { theme, toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")) };
}

export default function Layout() {
  const location = useLocation();
  const outlet = useOutlet();
  const { theme, toggle } = useTheme();

  return (
    <div className="relative flex h-screen overflow-hidden">
      <div className="lg-aurora" aria-hidden="true"><i></i><i></i><i></i></div>

      <aside className="lg-glass lg-spec relative z-10 m-2.5 mr-0 flex w-[248px] flex-col rounded-[24px]">
        <div className="flex items-center gap-3 px-5 pb-4 pt-6">
          <span className="flex h-10 w-10 items-center justify-center rounded-[13px] bg-gradient-to-br from-[var(--lg-accent2)] to-[var(--lg-accent)] shadow-[0_6px_16px_-4px_var(--lg-accent-soft),inset_0_1px_0_rgba(255,255,255,0.4)]">
            <Shirt className="h-[22px] w-[22px] text-white" strokeWidth={2} />
          </span>
          <div>
            <h1 className="text-[16px] font-bold leading-tight tracking-[-0.02em]">宏发洗衣店</h1>
            <p className="text-[11px] font-medium text-[var(--lg-ink3)]">柜台管理系统</p>
          </div>
        </div>

        <div className="mx-4 mb-1 mt-1 h-px bg-[var(--lg-hair)]" />

        <nav className="flex-1 space-y-0.5 px-2.5 py-2">
          {nav.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.to === "/"}>
              {({ isActive }) => (
                <span
                  className={cn(
                    "lg-pressable group relative flex items-center gap-3 rounded-[13px] px-3.5 py-2.5 text-[14px] font-medium transition-colors duration-200",
                    isActive ? "text-[var(--lg-accent)]" : "text-[var(--lg-ink2)] hover:text-[var(--lg-ink)]",
                  )}
                >
                  {isActive && (
                    <motion.span
                      layoutId="nav-pill"
                      className="lg-inset absolute inset-0 -z-10 rounded-[13px] shadow-[var(--lg-shadow-xs)]"
                      style={{ background: "var(--lg-leaf-hover)" }}
                      transition={{ type: "spring", stiffness: 480, damping: 36 }}
                    />
                  )}
                  <item.icon className="h-[18px] w-[18px] flex-none" strokeWidth={2} />
                  {item.label}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="space-y-2 p-2.5">
          <button
            onClick={toggle}
            className="lg-pressable lg-inset flex w-full items-center gap-2.5 rounded-[13px] px-3.5 py-2.5 text-[13px] font-medium text-[var(--lg-ink2)] transition-colors hover:text-[var(--lg-ink)]"
          >
            {theme === "dark" ? <Moon className="h-[17px] w-[17px]" strokeWidth={2} /> : <Sun className="h-[17px] w-[17px]" strokeWidth={2} />}
            {theme === "dark" ? "深色模式" : "浅色模式"}
          </button>
          <div className="lg-inset flex items-center gap-3 rounded-[15px] p-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--lg-accent-soft)] text-[13px] font-bold text-[var(--lg-accent)]">周</span>
            <div className="min-w-0 leading-tight">
              <p className="truncate text-[13px] font-semibold">周学胜</p>
              <p className="flex items-center gap-1 text-[11px] text-[var(--lg-ok-ink)]">
                <span className="h-1.5 w-1.5 rounded-full bg-[var(--lg-ok-ink)]" />店长 · 在线
              </p>
            </div>
          </div>
        </div>
      </aside>

      <main className="relative z-10 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1160px] px-8 py-7">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: 14, filter: "blur(5px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] } }}
              exit={{ opacity: 0, y: -8, filter: "blur(5px)", transition: { duration: 0.14 } }}
            >
              {outlet}
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}
