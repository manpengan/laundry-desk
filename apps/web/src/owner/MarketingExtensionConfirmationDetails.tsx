import type {
  MarketingGroupBuyRedemptionConfirmationSummary,
  MarketingGroupBuyRegistrationConfirmationSummary,
  MarketingReferralRewardConfirmationSummary,
} from "@laundry/contracts";

const money = (cents: number) => `¥${(cents / 100).toFixed(2)}`;

export function MarketingReferralConfirmationDetails({
  summary,
}: Readonly<{ summary: MarketingReferralRewardConfirmationSummary }>) {
  return (
    <dl className="ld-confirmation-summary">
      <div>
        <dt>操作</dt>
        <dd>发放推荐奖励</dd>
      </div>
      <div>
        <dt>活动 ID</dt>
        <dd>{summary.campaign_id}</dd>
      </div>
      <div>
        <dt>活动版本</dt>
        <dd>v{summary.campaign_version}</dd>
      </div>
      <div>
        <dt>推荐人顾客 ID</dt>
        <dd>{summary.referrer_customer_id}</dd>
      </div>
      <div>
        <dt>被推荐人顾客 ID</dt>
        <dd>{summary.referred_customer_id}</dd>
      </div>
      <div>
        <dt>资格订单 ID</dt>
        <dd>{summary.qualifying_order_id}</dd>
      </div>
      <div>
        <dt>奖励券定义 ID</dt>
        <dd>{summary.coupon_definition_id}</dd>
      </div>
      <div>
        <dt>奖励券版本</dt>
        <dd>v{summary.coupon_version}</dd>
      </div>
      <div>
        <dt>奖励券代码</dt>
        <dd>{summary.coupon_code}</dd>
      </div>
      <div>
        <dt>奖励券名称</dt>
        <dd>{summary.coupon_name}</dd>
      </div>
      <div>
        <dt>奖励券面额</dt>
        <dd>{money(summary.coupon_discount_cents)}</dd>
      </div>
      <div>
        <dt>最低消费</dt>
        <dd>{money(summary.coupon_min_order_cents)}</dd>
      </div>
      <div>
        <dt>有效天数</dt>
        <dd>{summary.coupon_valid_days} 天</dd>
      </div>
      <div>
        <dt>预算余额</dt>
        <dd>{money(summary.budget_remaining_cents)}</dd>
      </div>
      <div>
        <dt>发放原因</dt>
        <dd>{summary.reason}</dd>
      </div>
    </dl>
  );
}

export function MarketingGroupBuyRegistrationDetails({
  summary,
}: Readonly<{ summary: MarketingGroupBuyRegistrationConfirmationSummary }>) {
  return (
    <dl className="ld-confirmation-summary">
      <div>
        <dt>操作</dt>
        <dd>登记团购券</dd>
      </div>
      <div>
        <dt>平台</dt>
        <dd>{summary.provider}</dd>
      </div>
      <div>
        <dt>平台订单号</dt>
        <dd>{summary.external_order_ref}</dd>
      </div>
      <div>
        <dt>券码尾号</dt>
        <dd>•••• {summary.code_last4}</dd>
      </div>
      <div>
        <dt>券名称</dt>
        <dd>{summary.label}</dd>
      </div>
      <div>
        <dt>面值</dt>
        <dd>{money(summary.face_value_cents)}</dd>
      </div>
      <div>
        <dt>有效期</dt>
        <dd>{summary.expires_at}</dd>
      </div>
      <div>
        <dt>登记原因</dt>
        <dd>{summary.reason}</dd>
      </div>
    </dl>
  );
}

export function MarketingGroupBuyRedemptionDetails({
  summary,
}: Readonly<{ summary: MarketingGroupBuyRedemptionConfirmationSummary }>) {
  return (
    <dl className="ld-confirmation-summary">
      <div>
        <dt>操作</dt>
        <dd>核销团购券</dd>
      </div>
      <div>
        <dt>团购券 ID</dt>
        <dd>{summary.voucher_id}</dd>
      </div>
      <div>
        <dt>券码尾号</dt>
        <dd>•••• {summary.code_last4}</dd>
      </div>
      <div>
        <dt>平台</dt>
        <dd>{summary.provider}</dd>
      </div>
      <div>
        <dt>平台订单号</dt>
        <dd>{summary.external_order_ref}</dd>
      </div>
      <div>
        <dt>券名称</dt>
        <dd>{summary.label}</dd>
      </div>
      <div>
        <dt>券面值</dt>
        <dd>{money(summary.face_value_cents)}</dd>
      </div>
      <div>
        <dt>券有效期</dt>
        <dd>{summary.expires_at}</dd>
      </div>
      <div>
        <dt>订单 ID</dt>
        <dd>{summary.order_id}</dd>
      </div>
      <div>
        <dt>订单原价</dt>
        <dd>{money(summary.order_original_cents)}</dd>
      </div>
      <div>
        <dt>核销前应收</dt>
        <dd>{money(summary.order_payable_before_cents)}</dd>
      </div>
      <div>
        <dt>核销优惠</dt>
        <dd>{money(summary.applied_discount_cents)}</dd>
      </div>
      <div>
        <dt>优惠后应收</dt>
        <dd>{money(summary.order_payable_before_cents - summary.applied_discount_cents)}</dd>
      </div>
      <div>
        <dt>核销原因</dt>
        <dd>{summary.reason}</dd>
      </div>
    </dl>
  );
}
