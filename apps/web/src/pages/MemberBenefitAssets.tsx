import { Button, Input, MoneyText } from "@laundry/ui";
import { useMemo, useState } from "react";

import {
  buildAssetGrantBody,
  buildPunchConsumeBody,
  type MemberBenefitCatalogView,
  type MemberBenefitsView,
} from "./member-benefits-model.js";
import type { BenefitToast, RunBenefitMutation } from "./member-benefits-ui-types.js";

export type MemberBenefitAssetsProps = Readonly<{
  benefits: MemberBenefitsView;
  catalog: MemberBenefitCatalogView;
  isAdmin: boolean;
  busy: boolean;
  mutable: boolean;
  toast: BenefitToast;
  runMutation: RunBenefitMutation;
}>;

function assetStatus(status: "active" | "exhausted" | "expired" | "redeemed"): string {
  if (status === "active") return "可用";
  if (status === "exhausted") return "已用尽";
  if (status === "redeemed") return "已核销";
  return "已到期";
}

export function MemberBenefitAssets({
  benefits,
  catalog,
  isAdmin,
  busy,
  mutable,
  toast,
  runMutation,
}: MemberBenefitAssetsProps) {
  const [grantKind, setGrantKind] = useState<"punch" | "coupon">("punch");
  const [grantDefinitionId, setGrantDefinitionId] = useState("");
  const [grantReason, setGrantReason] = useState("");
  const [punchId, setPunchId] = useState("");
  const [punchUses, setPunchUses] = useState("1");
  const [punchReason, setPunchReason] = useState("");
  const grantDefinitions = useMemo(
    () =>
      grantKind === "punch"
        ? catalog.punch_types.filter((item) => item.status === "active")
        : catalog.coupon_types.filter((item) => item.status === "active"),
    [catalog, grantKind],
  );
  const activePunches = useMemo(
    () => benefits.punch_cards.filter((item) => item.status === "active"),
    [benefits],
  );

  return (
    <div className="ld-benefit-section" data-testid="member-assets">
      <h4>次卡与优惠券</h4>
      {isAdmin ? (
        <div className="ld-benefit-form">
          <label className="ld-member-panel__method">
            <span>发放类型</span>
            <select
              value={grantKind}
              disabled={busy || !mutable}
              onChange={(event) => {
                setGrantKind(event.target.value as "punch" | "coupon");
                setGrantDefinitionId("");
              }}
            >
              <option value="punch">次卡</option>
              <option value="coupon">优惠券</option>
            </select>
          </label>
          <label className="ld-member-panel__method">
            <span>定义</span>
            <select
              value={grantDefinitionId}
              disabled={busy || !mutable}
              onChange={(event) => setGrantDefinitionId(event.target.value)}
            >
              <option value="">请选择</option>
              {grantDefinitions.map((item) => (
                <option key={item.definition_id} value={item.definition_id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <Input
            label="发放原因"
            value={grantReason}
            disabled={busy || !mutable}
            onChange={(event) => setGrantReason(event.target.value)}
          />
          <Button
            type="button"
            variant="primary"
            disabled={busy || !mutable}
            onClick={() => {
              const body = buildAssetGrantBody(
                grantKind,
                benefits.account_id,
                grantDefinitionId,
                grantReason,
              );
              if (body === null) {
                toast.push("请选择有效定义并填写发放原因", "error");
                return;
              }
              void runMutation("member.asset.grant", body, "确认发放会员资产", "会员资产已发放");
            }}
          >
            发放
          </Button>
        </div>
      ) : null}

      <h5>次卡</h5>
      {benefits.punch_cards.length === 0 ? (
        <p className="ld-member-panel__hint">暂无次卡。</p>
      ) : (
        <ul className="ld-benefit-assets">
          {benefits.punch_cards.map((card) => (
            <li key={card.asset_id}>
              <span>
                {card.name} · 剩余 {card.remaining_uses}/{card.total_uses} 次 ·{" "}
                {assetStatus(card.status)} · 到期 {card.expires_on}
              </span>
            </li>
          ))}
        </ul>
      )}
      {activePunches.length > 0 ? (
        <div className="ld-benefit-form">
          <label className="ld-member-panel__method">
            <span>使用次卡</span>
            <select
              value={punchId}
              disabled={busy || !mutable}
              onChange={(event) => setPunchId(event.target.value)}
            >
              <option value="">请选择</option>
              {activePunches.map((card) => (
                <option key={card.asset_id} value={card.asset_id}>
                  {card.name}（余 {card.remaining_uses} 次）
                </option>
              ))}
            </select>
          </label>
          <Input
            label="使用次数"
            value={punchUses}
            inputMode="numeric"
            disabled={busy || !mutable}
            onChange={(event) => setPunchUses(event.target.value)}
          />
          <Input
            label="使用原因"
            value={punchReason}
            disabled={busy || !mutable}
            onChange={(event) => setPunchReason(event.target.value)}
          />
          <Button
            type="button"
            variant="secondary"
            disabled={busy || !mutable}
            onClick={() => {
              const body = buildPunchConsumeBody(punchId, Number(punchUses), punchReason);
              if (body === null) {
                toast.push("请选择次卡，输入 1–100 次和使用原因", "error");
                return;
              }
              void runMutation("member.asset.consume", body, "", "次卡已核销");
            }}
          >
            核销次卡
          </Button>
        </div>
      ) : null}

      <h5>优惠券</h5>
      {benefits.coupons.length === 0 ? (
        <p className="ld-member-panel__hint">暂无优惠券。</p>
      ) : (
        <ul className="ld-benefit-assets">
          {benefits.coupons.map((coupon) => (
            <li key={coupon.asset_id}>
              <span>
                {coupon.name} · 减 <MoneyText fen={coupon.discount_cents} /> · 满{" "}
                <MoneyText fen={coupon.min_order_cents} /> · {assetStatus(coupon.status)} · 到期{" "}
                {coupon.expires_on}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
