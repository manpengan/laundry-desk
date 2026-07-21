import { cn } from "../lib/cn.js";
import { StatusBadge } from "./StatusBadge.js";

export type PrintJobSummary = {
  queued: number;
  failed: number;
};

export type PrintJobIndicatorProps = {
  summary: PrintJobSummary;
  onOpen?: () => void;
  className?: string;
};

export function printIndicatorLabel(summary: PrintJobSummary): string {
  if (summary.failed > 0) return `打印失败 ${summary.failed}`;
  if (summary.queued > 0) return `打印排队 ${summary.queued}`;
  return "打印空闲";
}

export function printIndicatorStatus(summary: PrintJobSummary): "queued" | "failed" | "done" {
  if (summary.failed > 0) return "failed";
  if (summary.queued > 0) return "queued";
  return "done";
}

/** Header print queue chip — UI only until D4 job schema freezes. */
export function PrintJobIndicator({ summary, onOpen, className }: PrintJobIndicatorProps) {
  const status = printIndicatorStatus(summary);
  const label = printIndicatorLabel(summary);
  return (
    <button
      type="button"
      className={cn("ld-print-indicator", className)}
      onClick={onOpen}
      aria-label={label}
      data-failed={summary.failed}
      data-queued={summary.queued}
    >
      <StatusBadge family="print" status={status} label={label} />
    </button>
  );
}
