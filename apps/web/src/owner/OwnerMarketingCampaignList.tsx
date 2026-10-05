import type { MarketingCampaign } from "@laundry/contracts";
import { Button } from "@laundry/ui";

export function OwnerMarketingCampaignList({
  campaigns,
  onSelect,
  onNew,
}: Readonly<{
  campaigns: readonly MarketingCampaign[];
  onSelect: (campaign: MarketingCampaign) => void;
  onNew: () => void;
}>) {
  return (
    <section className="ld-owner-management lg-card">
      <header className="ld-owner-management__header">
        <div>
          <span className="ld-owner-operations__eyebrow">当前门店 · 按预算与权限执行</span>
          <h2>营销活动</h2>
          <p>先配置活动、受众、时间窗与预算，再冻结受众并预览发券；执行前需确认发放范围与费用。</p>
        </div>
        <Button type="button" variant="secondary" onClick={onNew}>
          新建
        </Button>
      </header>
      {campaigns.length === 0 ? (
        <p>尚无活动。</p>
      ) : (
        <div className="ld-owner-management__table-wrap">
          <table className="ld-owner-management__table">
            <thead>
              <tr>
                <th>活动</th>
                <th>状态</th>
                <th>预算</th>
                <th>版本</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((campaign) => (
                <tr key={campaign.campaign_id}>
                  <th>
                    <button
                      type="button"
                      className="ld-marketing-link"
                      onClick={() => onSelect(campaign)}
                    >
                      {campaign.name}
                      <small>{campaign.code}</small>
                    </button>
                  </th>
                  <td>
                    {{
                      draft: "草稿",
                      scheduled: "已排期",
                      paused: "已暂停",
                      cancelled: "已取消",
                    }[campaign.status] ?? campaign.status}
                  </td>
                  <td>¥{(campaign.budget_limit_cents / 100).toFixed(2)}</td>
                  <td>{campaign.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
