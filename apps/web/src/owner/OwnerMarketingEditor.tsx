import { Button, Input } from "@laundry/ui";

import type { MarketingCampaignDraft } from "./owner-marketing-model.js";

export type OwnerMarketingEditorProps = Readonly<{
  draft: MarketingCampaignDraft;
  busy: boolean;
  hasSelected: boolean;
  preview: Readonly<{
    matched_count: number;
    recipient_count: number;
    truncated: boolean;
  }> | null;
  onChange: <TKey extends keyof MarketingCampaignDraft>(
    key: TKey,
    value: MarketingCampaignDraft[TKey],
  ) => void;
  onSave: () => void;
  onPreview: () => void;
  onFreeze: () => void;
}>;

export function OwnerMarketingEditor({
  draft,
  busy,
  hasSelected,
  preview,
  onChange,
  onSave,
  onPreview,
  onFreeze,
}: OwnerMarketingEditorProps) {
  return (
    <section className="ld-owner-management lg-card" aria-label="活动编辑器">
      <div className="ld-owner-management__form">
        <Input
          name="marketing-code"
          label="代码"
          value={draft.code}
          disabled={busy || hasSelected}
          onChange={(event) => onChange("code", event.target.value)}
        />
        <Input
          name="marketing-name"
          label="名称"
          value={draft.name}
          disabled={busy}
          onChange={(event) => onChange("name", event.target.value)}
        />
        <label className="ld-marketing-field">
          状态
          <select
            value={draft.status}
            disabled={busy}
            onChange={(event) =>
              onChange("status", event.target.value as MarketingCampaignDraft["status"])
            }
          >
            <option value="draft">草稿</option>
            <option value="scheduled">已排期</option>
            <option value="paused">暂停</option>
            <option value="cancelled">取消（不可恢复）</option>
          </select>
        </label>
        <Input
          name="marketing-budget"
          label="预算上限（元）"
          value={draft.budgetYuan}
          disabled={busy}
          onChange={(event) => onChange("budgetYuan", event.target.value)}
        />
        <Input
          name="marketing-start"
          label="开始时间"
          type="datetime-local"
          value={draft.startsAt}
          disabled={busy}
          onChange={(event) => onChange("startsAt", event.target.value)}
        />
        <Input
          name="marketing-end"
          label="结束时间"
          type="datetime-local"
          value={draft.endsAt}
          disabled={busy}
          onChange={(event) => onChange("endsAt", event.target.value)}
        />
        <Input
          name="marketing-limit"
          label="受众上限（最多 500）"
          value={draft.recipientLimit}
          disabled={busy}
          onChange={(event) => onChange("recipientLimit", event.target.value)}
        />
        <Input
          name="marketing-age"
          label="新客天数（留空=不限）"
          value={draft.customerAgeDays}
          disabled={busy}
          onChange={(event) => onChange("customerAgeDays", event.target.value)}
        />
        <label className="ld-marketing-field">
          下单活跃
          <select
            value={draft.orderActivity}
            disabled={busy}
            onChange={(event) =>
              onChange(
                "orderActivity",
                event.target.value as MarketingCampaignDraft["orderActivity"],
              )
            }
          >
            <option value="any">不限</option>
            <option value="none">从未下单</option>
            <option value="within_days">最近若干天</option>
          </select>
        </label>
        <Input
          name="marketing-activity-days"
          label="活跃天数"
          value={draft.orderActivityDays}
          disabled={busy || draft.orderActivity !== "within_days"}
          onChange={(event) => onChange("orderActivityDays", event.target.value)}
        />
        <label className="ld-marketing-field">
          会员条件
          <select
            value={draft.membership}
            disabled={busy}
            onChange={(event) =>
              onChange("membership", event.target.value as MarketingCampaignDraft["membership"])
            }
          >
            <option value="any">不限</option>
            <option value="member">有效会员</option>
            <option value="non_member">非会员</option>
            <option value="tiers">指定会员等级</option>
          </select>
        </label>
        <Input
          name="marketing-tier-ids"
          label="会员等级 ID（逗号分隔）"
          value={draft.tierIds}
          disabled={busy || draft.membership !== "tiers"}
          onChange={(event) => onChange("tierIds", event.target.value)}
        />
      </div>
      <div className="ld-marketing-actions">
        <Button type="button" variant="primary" disabled={busy} onClick={onSave}>
          {busy ? "处理中…" : "保存活动"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={busy || !hasSelected}
          onClick={onPreview}
        >
          预览受众
        </Button>
        <Button
          type="button"
          variant="danger"
          disabled={busy || !hasSelected || preview === null}
          onClick={onFreeze}
        >
          冻结当前受众
        </Button>
      </div>
      {preview === null ? null : (
        <p className="ld-marketing-preview" role="status">
          匹配 {preview.matched_count} 人，本次冻结 {preview.recipient_count} 人
          {preview.truncated ? "（已按上限截断）" : ""}；仅保存摘要，不保存名单。
        </p>
      )}
    </section>
  );
}
