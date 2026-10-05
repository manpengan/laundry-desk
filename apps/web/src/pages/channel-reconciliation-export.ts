import type { ReconciliationDifference } from "@laundry/contracts";
import type { PaymentChannelPort } from "../host/payment-channel-port.js";

export const DIFFERENCE_LABELS = {
  missing_local: "本机缺少流水",
  missing_provider: "渠道账单缺少流水",
  amount_mismatch: "金额不同",
  state_mismatch: "状态不同",
  reference_mismatch: "流水号不同",
  duplicate_provider: "渠道流水重复",
} as const;
export const REVIEW_LABELS = {
  open: "待复核",
  investigating: "处理中",
  resolved: "已复核",
} as const;
function csvCell(value: string | number): string {
  const text = String(value);
  const safe = /^[\s]*[=+@-]/u.test(text) ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}
export function reconciliationCsv(rows: readonly ReconciliationDifference[]): string {
  const values = rows.map((row) => [
    row.index + 1,
    row.merchant_order,
    row.merchant_refund ?? "",
    DIFFERENCE_LABELS[row.reason],
    row.order_id ?? "",
    REVIEW_LABELS[row.review.state],
    row.review.note,
    row.review.reviewed_at ?? "",
  ]);
  return (
    "\uFEFF" +
    [
      ["序号", "商户订单号", "退款号", "差异", "本机订单", "复核状态", "备注", "复核时间"],
      ...values,
    ]
      .map((row) => row.map(csvCell).join(","))
      .join("\r\n")
  );
}
export async function exportReconciliation(port: PaymentChannelPort, id: string): Promise<string> {
  const rows: ReconciliationDifference[] = [];
  for (let offset = 0; offset < 10000; offset += 100) {
    const result = await port.reconciliationDetail({ reconciliation_id: id, offset, limit: 100 });
    if (!result.ok) throw new Error(result.error);
    if (result.data.offset !== offset || result.data.summary.reconciliation_id !== id)
      throw new Error("对账导出响应不匹配，请重试");
    rows.push(...result.data.rows);
    if (rows.length >= result.data.summary.mismatch_count) return reconciliationCsv(rows);
    if (result.data.rows.length !== 100) throw new Error("对账导出不完整，请重试");
  }
  throw new Error("差异数量超过导出上限");
}
export function downloadReconciliation(csv: string, id: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `对账差异-${id}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
