import { cn } from "../lib/cn.js";
import { StatusBadge } from "./StatusBadge.js";

export type SyncStatusBarProps = {
  mode: "online" | "offline" | "degraded";
  pendingSyncCount: number;
  className?: string;
};

function syncKey(mode: SyncStatusBarProps["mode"], pending: number): string {
  if (mode === "offline") return "offline";
  if (pending > 0) return "pending";
  return "online";
}

export function formatSyncLabel(
  mode: SyncStatusBarProps["mode"],
  pendingSyncCount: number,
): string {
  const modeLabel = mode === "online" ? "在线" : mode === "offline" ? "离线" : "降级";
  const pending = pendingSyncCount <= 0 ? "0 笔待同步" : `${pendingSyncCount} 笔待同步`;
  return `${modeLabel} · ${pending}`;
}

/** Top-bar connection strip (UI only — wire to Edge later). */
export function SyncStatusBar({ mode, pendingSyncCount, className }: SyncStatusBarProps) {
  const status = syncKey(mode, pendingSyncCount);
  return (
    <div className={cn("ld-sync-bar", className)} data-mode={mode} data-pending={pendingSyncCount}>
      <StatusBadge family="sync" status={status} />
      <span>{formatSyncLabel(mode, pendingSyncCount)}</span>
    </div>
  );
}
