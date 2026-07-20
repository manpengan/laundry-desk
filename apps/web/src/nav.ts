/** Desktop left rail items (UI spec §3). Auth gating is E3 — all visible for now. */

export type NavItemId = "workbench" | "receive" | "pickup" | "customers" | "stats" | "settings";

export type NavItem = {
  id: NavItemId;
  label: string;
  icon: string;
};

export const COUNTER_NAV: readonly NavItem[] = [
  { id: "workbench", label: "工作台", icon: "⌂" },
  { id: "receive", label: "开单", icon: "＋" },
  { id: "pickup", label: "取衣", icon: "↓" },
  { id: "customers", label: "客户", icon: "人" },
  { id: "stats", label: "统计", icon: "▣" },
  { id: "settings", label: "设置", icon: "⚙" },
] as const;

export function navLabel(id: NavItemId): string {
  const hit = COUNTER_NAV.find((n) => n.id === id);
  return hit?.label ?? id;
}
