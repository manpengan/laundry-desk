import type {
  MarketingAudienceFreezeConfirmationSummary,
  MarketingCampaignSetConfirmationSummary,
} from "@laundry/contracts";
import { MoneyText } from "@laundry/ui";

function ruleText(rule: MarketingCampaignSetConfirmationSummary["audience_rule"]): string {
  const age =
    rule.customer_age.kind === "any" ? "注册时间不限" : `注册 ${rule.customer_age.days} 天内`;
  const activity =
    rule.order_activity.kind === "any"
      ? "订单不限"
      : rule.order_activity.kind === "none"
        ? "从未下单"
        : `${rule.order_activity.days} 天内下过单`;
  const membership =
    rule.membership.kind === "any"
      ? "会员不限"
      : rule.membership.kind === "member"
        ? "有效会员"
        : rule.membership.kind === "non_member"
          ? "非会员"
          : `指定等级：${rule.membership.tier_ids.join("、")}`;
  return `${age}；${activity}；${membership}`;
}

export function MarketingCampaignSetConfirmationDetails({
  summary,
}: Readonly<{ summary: MarketingCampaignSetConfirmationSummary }>) {
  return (
    <div data-testid="marketing-campaign-set-confirmation">
      <p>
        {summary.campaign_id === undefined ? "新建活动" : `活动 ${summary.campaign_id}`}；版本{" "}
        {summary.expected_version} → {summary.expected_version + 1}
      </p>
      <p>
        {summary.name}（{summary.code}）· {summary.status}
      </p>
      <p>
        {summary.starts_at} 至 {summary.ends_at}
      </p>
      <p>
        预算上限 <MoneyText fen={summary.budget_limit_cents} />
        ；受众上限 {summary.recipient_limit} 人
      </p>
      <p>{ruleText(summary.audience_rule)}</p>
    </div>
  );
}

export function MarketingAudienceFreezeConfirmationDetails({
  summary,
}: Readonly<{ summary: MarketingAudienceFreezeConfirmationSummary }>) {
  return (
    <div data-testid="marketing-audience-freeze-confirmation">
      <p>
        {summary.campaign_name}（{summary.campaign_code}）
      </p>
      <p>
        活动 {summary.campaign_id} · 版本 {summary.campaign_version} · 冻结{" "}
        {summary.recipient_count} 人
      </p>
      <p>规则摘要：{summary.audience_rule_sha256}</p>
      <p>受众摘要：{summary.audience_digest}</p>
    </div>
  );
}
