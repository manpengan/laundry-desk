import { cn } from "../lib/cn.js";
import { StatusBadge } from "./StatusBadge.js";

export type SyncStatusBarProps = {
  mode: "online" | "offline" | "degraded";
  pendingSyncCount: number | null;
  detail?: string;
  className?: string;
};

function syncKey(mode: SyncStatusBarProps["mode"], pending: number | null): string {
  if (mode === "offline") return "offline";
  if (mode === "degraded" || (pending !== null && pending > 0)) return "pending";
  return "online";
}

export function formatSyncLabel(
  mode: SyncStatusBarProps["mode"],
  pendingSyncCount: number | null,
): string {
  const modeLabel = mode === "online" ? "在线" : mode === "offline" ? "离线" : "降级";
  const pending =
    pendingSyncCount === null
      ? "同步状态未知"
      : pendingSyncCount <= 0
        ? "0 笔待同步"
        : `${pendingSyncCount} 笔待同步`;
  return `${modeLabel} · ${pending}`;
}

/** Short detail beside the badge; the badge already names the mode. */
export function formatSyncDetail(pendingSyncCount: number | null): string {
  if (pendingSyncCount === null) return "同步状态未知";
  return pendingSyncCount <= 0 ? "全部已同步" : `${pendingSyncCount} 笔待同步`;
}

/** Top-bar connection strip: one badge for the mode, one detail for the queue. */
export function SyncStatusBar({ mode, pendingSyncCount, detail, className }: SyncStatusBarProps) {
  const status = syncKey(mode, pendingSyncCount);
  const message =
    detail ?? (mode === "offline" ? "恢复连接后核对同步状态" : formatSyncDetail(pendingSyncCount));
  const label = `${mode === "online" ? "在线" : mode === "offline" ? "离线" : "降级"} · ${message}`;
  return (
    <div
      className={cn("ld-sync-bar", className)}
      data-mode={mode}
      data-pending={pendingSyncCount}
      role="status"
      aria-label={label}
      title={label}
    >
      <StatusBadge family="sync" status={status} />
      <span className="ld-sync-bar__detail">{message}</span>
    </div>
  );
}
