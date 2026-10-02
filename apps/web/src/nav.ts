/** Desktop left rail items (UI spec §3). Visibility filtered by E3 permissions. */

import type { IconName } from "@laundry/ui";

export type NavItemId =
  | "workbench"
  | "receive"
  | "pickup"
  | "delivery"
  | "fulfillment"
  | "orders"
  | "customers"
  | "reminders"
  | "stats"
  | "settings";

export type NavItem = {
  id: NavItemId;
  label: string;
  /** Compact label under the rail icon when the sidebar is collapsed. */
  shortLabel: string;
  icon: IconName;
  /** Pinyin / initials / English so the command palette works without an IME. */
  keywords: string;
};

export const COUNTER_NAV: readonly NavItem[] = [
  {
    id: "workbench",
    label: "工作台",
    shortLabel: "工作台",
    icon: "home",
    keywords: "gongzuotai gzt shouye home workbench",
  },
  {
    id: "receive",
    label: "开单",
    shortLabel: "开单",
    icon: "receive",
    keywords: "kaidan kd shouyi receive order",
  },
  { id: "pickup", label: "取衣", shortLabel: "取衣", icon: "pickup", keywords: "quyi qy pickup" },
  {
    id: "delivery",
    label: "取送订单",
    shortLabel: "取送",
    icon: "delivery",
    keywords: "qusong qs peisong delivery",
  },
  {
    id: "fulfillment",
    label: "生产",
    shortLabel: "生产",
    icon: "fulfillment",
    keywords: "shengchan sc jiagong shangjia fulfillment factory",
  },
  {
    id: "orders",
    label: "订单与欠款",
    shortLabel: "欠款",
    icon: "orders",
    keywords: "dingdan qiankuan dd qk orders debt",
  },
  {
    id: "customers",
    label: "客户",
    shortLabel: "客户",
    icon: "customers",
    keywords: "kehu kh huiyuan customers",
  },
  {
    id: "reminders",
    label: "催取",
    shortLabel: "催取",
    icon: "reminders",
    keywords: "cuiqu cq reminders",
  },
  {
    id: "stats",
    label: "账目 / 对账",
    shortLabel: "账目",
    icon: "stats",
    keywords: "zhangmu duizhang zm dz jiaoban rijie stats",
  },
  {
    id: "settings",
    label: "设置",
    shortLabel: "设置",
    icon: "settings",
    keywords: "shezhi sz settings",
  },
] as const;

export function navLabel(id: NavItemId): string {
  const hit = COUNTER_NAV.find((n) => n.id === id);
  return hit?.label ?? id;
}

/** Alt+1…Alt+9, Alt+0 jump to the visible rail items in order. */
export function navShortcutKey(index: number): string | null {
  if (index < 0 || index > 9) return null;
  return index === 9 ? "0" : String(index + 1);
}

/** Pure: resolve an Alt+digit press against the permission-filtered rail. */
export function navTargetForDigit(items: readonly NavItem[], digit: string): NavItemId | null {
  const index = digit === "0" ? 9 : Number.parseInt(digit, 10) - 1;
  if (!Number.isInteger(index) || index < 0 || index > 9) return null;
  return items[index]?.id ?? null;
}
