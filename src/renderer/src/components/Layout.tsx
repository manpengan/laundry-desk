import { NavLink, useLocation, useOutlet } from "react-router-dom";
import { useEffect, useState } from "react";
import {
  LayoutGrid,
  ReceiptText,
  PackageSearch,
  ListChecks,
  Users2,
  BarChart3,
  Settings2,
  Sun,
  Moon,
  Shirt,
} from "lucide-react";
import { cn } from "@renderer/lib/utils";
import { AnimatePresence, motion } from "framer-motion";

const nav = [
  { to: "/", icon: LayoutGrid, label: "总览", short: "总览" },
  { to: "/receive", icon: ReceiptText, label: "收件登记", short: "收件" },
  { to: "/pickup", icon: PackageSearch, label: "取件查询", short: "取件" },
  { to: "/orders", icon: ListChecks, label: "订单列表", short: "订单" },
  { to: "/customers", icon: Users2, label: "客户管理", short: "客户" },
  { to: "/stats", icon: BarChart3, label: "统计报表", short: "统计" },
  { to: "/settings", icon: Settings2, label: "系统设置", short: "设置" },
];

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const s = document.documentElement.dataset.theme;
    if (s === "light" || s === "dark") return s;
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return {
    theme,
    toggle: () => setTheme((t) => (t === "dark" ? "light" : "dark")),
  };
}

function BrandMark({ size = 22 }: { size?: number }) {
  return (
    <span
      className="flex items-center justify-center rounded-[7px] bg-gradient-to-br from-[var(--lg-accent2)] to-[var(--lg-accent)] shadow-[inset_0_1px_0_rgba(255,255,255,0.45)]"
      style={{ width: size, height: size }}
    >
      <Shirt
        style={{ width: size * 0.6, height: size * 0.6 }}
        className="text-white"
        strokeWidth={2.4}
      />
    </span>
  );
}

export default function Layout() {
  const location = useLocation();
  const outlet = useOutlet();
  const { theme, toggle } = useTheme();

  return (
    <div className="relative h-full overflow-hidden p-0 md:p-3">
      <div className="lg-aurora" aria-hidden="true">
        <i></i>
        <i></i>
        <i></i>
        <i></i>
      </div>

      {/* 应用窗口（window 档玻璃，唯一 blur 层）；移动端全屏无框 */}
      <div className="lg-glass relative z-10 flex h-full flex-col overflow-hidden rounded-none md:rounded-[30px]">
        {/* 桌面标题栏 */}
        <div
          className="hidden items-center justify-between border-b px-5 py-3 md:flex"
          style={{ borderColor: "var(--lg-hair)" }}
        >
          <span className="flex items-center gap-2.5 text-[13px] font-semibold text-[var(--lg-ink2)]">
            <BrandMark />
            宏发洗衣店 — 柜台端
          </span>
          <span className="flex gap-1.5" aria-hidden="true">
            <i className="grid h-6 w-[34px] place-items-center rounded-[8px] text-[12px] not-italic text-[var(--lg-ink3)]">
              —
            </i>
            <i className="grid h-6 w-[34px] place-items-center rounded-[8px] text-[12px] not-italic text-[var(--lg-ink3)]">
              □
            </i>
            <i className="grid h-6 w-[34px] place-items-center rounded-[8px] text-[12px] not-italic text-[var(--lg-ink3)]">
              ✕
            </i>
          </span>
        </div>

        {/* 移动端顶栏 */}
        <div
          className="flex items-center justify-between border-b px-4 py-3 md:hidden"
          style={{ borderColor: "var(--lg-hair)" }}
        >
          <span className="flex items-center gap-2.5">
            <BrandMark size={26} />
            <span className="leading-tight">
              <span className="block text-[15px] font-bold tracking-[-0.01em]">
                宏发洗衣店
              </span>
              <span className="block text-[9px] font-bold uppercase tracking-[0.2em] text-[var(--lg-ink3)]">
                Counter OS
              </span>
            </span>
          </span>
          <button
            onClick={toggle}
            aria-label="切换主题"
            className="lg-pressable lg-inset grid h-9 w-9 place-items-center rounded-full text-[var(--lg-ink2)]"
          >
            {theme === "dark" ? (
              <Moon className="h-4 w-4" strokeWidth={2.2} />
            ) : (
              <Sun className="h-4 w-4" strokeWidth={2.2} />
            )}
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 桌面侧边栏 */}
          <aside
            className="hidden w-[228px] flex-col border-r px-3.5 py-5 md:flex"
            style={{ borderColor: "var(--lg-hair)" }}
          >
            <div className="px-3 pb-4">
              <h1 className="text-[19px] font-bold leading-tight tracking-[-0.02em]">
                宏发洗衣店
              </h1>
              <p className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.22em] text-[var(--lg-ink3)]">
                Counter OS
              </p>
            </div>

            <nav className="flex-1 space-y-1">
              {nav.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.to === "/"}>
                  {({ isActive }) => (
                    <span
                      className={cn(
                        "lg-pressable group relative flex items-center gap-3 rounded-[15px] px-3.5 py-[11px] text-[14px] font-semibold transition-colors duration-200",
                        isActive
                          ? "text-[var(--lg-accent)]"
                          : "text-[var(--lg-ink2)] hover:text-[var(--lg-ink)]",
                      )}
                    >
                      {isActive && (
                        <motion.span
                          layoutId="nav-pill"
                          className="absolute inset-0 -z-10 rounded-[15px]"
                          style={{
                            background:
                              "linear-gradient(135deg, var(--lg-glass-hi), var(--lg-leaf-hover))",
                            border: "1px solid var(--lg-line)",
                            boxShadow:
                              "var(--lg-shadow-xs), inset 0 1px 0 var(--lg-inner-hi)",
                          }}
                          transition={{
                            type: "spring",
                            stiffness: 460,
                            damping: 35,
                          }}
                        />
                      )}
                      <item.icon
                        className="h-[18px] w-[18px] flex-none"
                        strokeWidth={2}
                      />
                      {item.label}
                    </span>
                  )}
                </NavLink>
              ))}
            </nav>

            <div className="space-y-2">
              <button
                onClick={toggle}
                className="lg-pressable lg-inset flex w-full items-center gap-2.5 rounded-[13px] px-3.5 py-2.5 text-[13px] font-semibold text-[var(--lg-ink2)] transition-colors hover:text-[var(--lg-ink)]"
              >
                {theme === "dark" ? (
                  <Moon className="h-4 w-4" strokeWidth={2.2} />
                ) : (
                  <Sun className="h-4 w-4" strokeWidth={2.2} />
                )}
                {theme === "dark" ? "深色模式" : "浅色模式"}
              </button>
              <div className="lg-inset flex items-center gap-3 rounded-[16px] p-2.5">
                <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-[var(--lg-accent-soft)] text-[13px] font-bold text-[var(--lg-accent)]">
                  周
                </span>
                <div className="min-w-0 leading-tight">
                  <p className="truncate text-[13px] font-bold">
                    店长 · 周学胜
                  </p>
                  <p className="text-[11px] font-medium text-[var(--lg-ink3)]">
                    已登录 · 管理员
                  </p>
                </div>
              </div>
            </div>
          </aside>

          {/* 内容区 */}
          <main className="min-w-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[1080px] px-4 py-4 md:px-7 md:py-6">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={location.pathname}
                  initial={{ opacity: 0, y: 16, filter: "blur(6px)" }}
                  animate={{
                    opacity: 1,
                    y: 0,
                    filter: "blur(0px)",
                    transition: { duration: 0.26, ease: [0.22, 1, 0.36, 1] },
                  }}
                  exit={{
                    opacity: 0,
                    y: -10,
                    filter: "blur(6px)",
                    transition: { duration: 0.16 },
                  }}
                >
                  {outlet}
                </motion.div>
              </AnimatePresence>
            </div>
          </main>
        </div>

        {/* 移动端底部标签栏 */}
        <nav
          className="flex border-t pb-[env(safe-area-inset-bottom)] md:hidden"
          style={{ borderColor: "var(--lg-hair)" }}
        >
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className="min-w-0 flex-1"
            >
              {({ isActive }) => (
                <span
                  className={cn(
                    "lg-pressable flex flex-col items-center gap-0.5 py-2 text-[10px] font-semibold transition-colors",
                    isActive
                      ? "text-[var(--lg-accent)]"
                      : "text-[var(--lg-ink3)]",
                  )}
                >
                  <item.icon
                    className="h-[20px] w-[20px]"
                    strokeWidth={isActive ? 2.4 : 2}
                  />
                  {item.short}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  );
}
