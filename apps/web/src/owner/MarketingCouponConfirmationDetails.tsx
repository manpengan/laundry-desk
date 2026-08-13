import type {
  MarketingCouponIssueConfirmationSummary,
  MarketingCouponReversalConfirmationSummary,
} from "@laundry/contracts";

export function MarketingCouponIssueConfirmationDetails({
  summary,
}: Readonly<{ summary: MarketingCouponIssueConfirmationSummary }>) {
  return (
    <div>
      <p>
        活动：{summary.campaign_id} · v{summary.campaign_version}
      </p>
      <p>
        快照：{summary.snapshot_id} · 冻结受众 {summary.audience_recipient_count} 人
      </p>
      <p>
        券：{summary.coupon_name}（{summary.coupon_code} · v{summary.coupon_version}）· ¥
        {(summary.coupon_discount_cents / 100).toFixed(2)} × {summary.eligible_recipient_count} 人
      </p>
      <p>
        最低消费：¥{(summary.coupon_min_order_cents / 100).toFixed(2)} · 有效期：
        {summary.coupon_valid_days} 天
      </p>
      <p>预算占用：¥{(summary.budget_required_cents / 100).toFixed(2)}</p>
      <p>原因：{summary.reason}</p>
    </div>
  );
}

export function MarketingCouponReversalConfirmationDetails({
  summary,
}: Readonly<{ summary: MarketingCouponReversalConfirmationSummary }>) {
  return (
    <div>
      <p>核销 ID：{summary.redemption_id}</p>
      <p>订单 ID：{summary.order_id}</p>
      <p>冲正金额：¥{(summary.reversed_discount_cents / 100).toFixed(2)}</p>
      <p>原因：{summary.reason}</p>
    </div>
  );
}
