import type {
  CustomerPortalGarmentProgressResult,
  CustomerPortalOrderSummary,
} from "@laundry/contracts";

export const customerPortalStatusLabel = (status: string): string =>
  ({
    open: "处理中",
    closed: "已完成",
    cancelled: "已取消",
    received: "已收件",
    washing: "洗护中",
    ready: "待上架",
    racked: "待取件",
    picked_up: "已取件",
    delivered: "已送达",
    reworked: "返工中",
    lost: "异常处理中",
  })[status] ?? "状态更新中";

export function formatCustomerPortalCents(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) return "--";
  return `¥${(cents / 100).toFixed(2)}`;
}

export function newestOrderFirst(
  orders: readonly CustomerPortalOrderSummary[],
): readonly CustomerPortalOrderSummary[] {
  return Object.freeze(
    [...orders].sort((left, right) =>
      right.created_at === left.created_at
        ? right.order_id.localeCompare(left.order_id)
        : right.created_at.localeCompare(left.created_at),
    ),
  );
}

export function progressLabels(result: CustomerPortalGarmentProgressResult): readonly string[] {
  return Object.freeze(
    result.progress.map(
      (entry) => `${customerPortalStatusLabel(entry.to_status)} · ${entry.at.slice(0, 16)}`,
    ),
  );
}
