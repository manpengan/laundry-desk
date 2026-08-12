import { Button, Input } from "@laundry/ui";
import { useMemo, useState } from "react";

import {
  buildMembershipSetBody,
  buildPointsRedeemBody,
  type MemberBenefitCatalogView,
  type MemberBenefitsView,
} from "./member-benefits-model.js";
import type { BenefitToast, RunBenefitMutation } from "./member-benefits-ui-types.js";

export type MemberMembershipPointsProps = Readonly<{
  benefits: MemberBenefitsView;
  catalog: MemberBenefitCatalogView;
  isAdmin: boolean;
  busy: boolean;
  mutable: boolean;
  toast: BenefitToast;
  runMutation: RunBenefitMutation;
}>;

function membershipStatus(view: MemberBenefitsView): string {
  if (view.membership.status === "unassigned") return "未设置等级";
  if (view.membership.status === "expired") return "等级已到期";
  return "等级有效";
}

export function MemberMembershipPoints({
  benefits,
  catalog,
  isAdmin,
  busy,
  mutable,
  toast,
  runMutation,
}: MemberMembershipPointsProps) {
  const [tierId, setTierId] = useState(benefits.membership.tier?.definition_id ?? "");
  const [validUntil, setValidUntil] = useState(benefits.membership.valid_until ?? "");
  const [membershipReason, setMembershipReason] = useState("");
  const [redeemPoints, setRedeemPoints] = useState("");
  const [redeemReason, setRedeemReason] = useState("");
  const activeTiers = useMemo(
    () => catalog.tiers.filter((item) => item.status === "active"),
    [catalog],
  );

  return (
    <>
      <div className="ld-benefit-section" data-testid="member-membership">
        <h4>等级 · {membershipStatus(benefits)}</h4>
        <p>
          {benefits.membership.tier?.name ?? "无等级"}
          {benefits.membership.valid_until === null
            ? ""
            : `，有效至 ${benefits.membership.valid_until}`}{" "}
          · v{benefits.membership.version}
        </p>
        {isAdmin ? (
          <div className="ld-benefit-form">
            <label className="ld-member-panel__method">
              <span>等级</span>
              <select
                value={tierId}
                disabled={busy || !mutable}
                onChange={(event) => setTierId(event.target.value)}
                data-testid="membership-tier"
              >
                <option value="">清除等级</option>
                {activeTiers.map((tier) => (
                  <option key={tier.definition_id} value={tier.definition_id}>
                    {tier.name}（L{tier.level}）
                  </option>
                ))}
              </select>
            </label>
            {tierId === "" ? null : (
              <Input
                label="有效至"
                type="date"
                value={validUntil}
                disabled={busy || !mutable}
                onChange={(event) => setValidUntil(event.target.value)}
              />
            )}
            <Input
              label="变更原因"
              value={membershipReason}
              disabled={busy || !mutable}
              onChange={(event) => setMembershipReason(event.target.value)}
            />
            <Button
              variant="primary"
              type="button"
              disabled={busy || !mutable}
              onClick={() => {
                const body = buildMembershipSetBody(
                  benefits,
                  tierId === "" ? null : tierId,
                  tierId === "" ? null : validUntil,
                  membershipReason,
                );
                if (body === null) {
                  toast.push("请选择有效等级、未来日期并填写变更原因", "error");
                  return;
                }
                void runMutation(
                  "member.membership.set",
                  body,
                  "确认会员等级变更",
                  "会员等级已更新",
                );
              }}
            >
              保存等级
            </Button>
          </div>
        ) : null}
      </div>

      <div className="ld-benefit-section" data-testid="member-points">
        <h4>积分</h4>
        <p>
          可用 {benefits.points.available_points} 分；累计获得{" "}
          {benefits.points.lifetime_earned_points} 分。
        </p>
        <div className="ld-benefit-form">
          <Input
            label="兑换积分"
            value={redeemPoints}
            inputMode="numeric"
            disabled={busy || !mutable}
            onChange={(event) => setRedeemPoints(event.target.value)}
          />
          <Input
            label="兑换原因"
            value={redeemReason}
            disabled={busy || !mutable}
            onChange={(event) => setRedeemReason(event.target.value)}
          />
          <Button
            type="button"
            variant="secondary"
            disabled={busy || !mutable}
            onClick={() => {
              const body = buildPointsRedeemBody(
                benefits.account_id,
                Number(redeemPoints),
                redeemReason,
              );
              if (body === null) {
                toast.push("请输入正整数积分和兑换原因", "error");
                return;
              }
              void runMutation(
                "member.points.redeem",
                body,
                "确认积分兑换",
                `已兑换 ${body.points} 积分`,
              );
            }}
          >
            兑换积分
          </Button>
        </div>
        {benefits.points.recent.length === 0 ? (
          <p className="ld-member-panel__hint">暂无积分流水。</p>
        ) : (
          <ul className="ld-benefit-assets">
            {benefits.points.recent.map((row) => (
              <li key={row.ledger_id}>
                {row.kind === "earn" ? "获得" : "兑换"} {Math.abs(row.points_delta)} 分
                {row.expires_on === null ? "" : ` · 到期 ${row.expires_on}`}
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
