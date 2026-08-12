import type { NotificationDeliveryConfirmationSummary } from "@laundry/contracts";
import { MoneyText } from "@laundry/ui";

export function PendingSummary({
  summary,
}: Readonly<{ summary: NotificationDeliveryConfirmationSummary }>) {
  return (
    <ul className="ld-notification-delivery__summary">
      <li>订单：{summary.order_count} 单</li>
      <li>票号：{summary.ticket_nos.join("、")}</li>
      <li>近 24 小时风险累计：{summary.risk_window_order_count} 单</li>
      <li>通道：短信（{summary.provider_code}）</li>
      <li>
        模板：{summary.template_code} v{summary.template_version}
      </li>
      <li>
        预计成本：
        <MoneyText fen={summary.estimated_cost_cents} size="sm" />
      </li>
      <li>
        成本上限：
        <MoneyText fen={summary.max_cost_cents} size="sm" />
      </li>
      <li>
        通道保证：{summary.assurance === "software_only" ? "软件模拟，不会发送" : "外部短信回执"}
      </li>
      <li>
        筛选：{summary.min_age_days} 天以上 · {summary.unpaid_only ? "仅欠款" : "含已结清"} ·
        衣物状态 {summary.garment_statuses.join("/")}
      </li>
    </ul>
  );
}
