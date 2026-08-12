import {
  MarketingReferralRewardIssueInputSchema,
  MarketingReferralRewardIssueResultSchema,
  type MarketingCampaign,
  type MarketingReferralRewardConfirmationSummary,
} from "@laundry/contracts";
import { Button, Input, useToast } from "@laundry/ui";
import { useEffect, useRef, useState } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import type { CommandPort } from "../commands/types.js";
import { unwrapQueryResult } from "../pages/customer-model.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";
import { MarketingReferralConfirmationDetails } from "./MarketingExtensionConfirmationDetails.js";
import {
  marketingExtensionScopeKey,
  marketingReferralAuthorityKey,
  marketingReferralSummaryMatches,
  type MarketingExtensionEpoch,
} from "./marketing-extension-command.js";
import { useMarketingExtensionGuard } from "./use-marketing-extension-guard.js";

type Pending = Readonly<{
  ref: string;
  summary: MarketingReferralRewardConfirmationSummary;
}>;

export type OwnerMarketingReferralProps = Readonly<{
  campaign: MarketingCampaign | null;
  session: SessionView;
  authClient: AuthClient;
  commandClient: CommandPort;
  onChanged: () => Promise<void>;
}>;

export function OwnerMarketingReferral({
  campaign,
  session,
  authClient,
  commandClient,
  onChanged,
}: OwnerMarketingReferralProps) {
  const toast = useToast();
  const [referrerId, setReferrerId] = useState("");
  const [referredId, setReferredId] = useState("");
  const [orderId, setOrderId] = useState("");
  const [couponId, setCouponId] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const scopeKey = marketingExtensionScopeKey(
    session,
    JSON.stringify([campaign?.campaign_id ?? null, campaign?.version ?? null]),
  );
  const guard = useMarketingExtensionGuard(scopeKey);
  const pendingEpoch = useRef<MarketingExtensionEpoch | null>(null);

  useEffect(() => {
    pendingEpoch.current = null;
    setPending(null);
  }, [scopeKey]);
  const activePending =
    pendingEpoch.current !== null && guard.current(pendingEpoch.current) ? pending : null;

  const invalidate = () => {
    pendingEpoch.current = null;
    guard.invalidate();
    setPending(null);
  };
  const apply = async (epoch: MarketingExtensionEpoch, value: unknown) => {
    if (!guard.current(epoch)) return;
    const parsed = MarketingReferralRewardIssueResultSchema.safeParse(unwrapQueryResult(value));
    if (!parsed.success) throw new Error("invalid referral reward result");
    if (!guard.current(epoch)) return;
    setPending(null);
    pendingEpoch.current = null;
    toast.push(
      parsed.data.reward.replayed ? "推荐奖励此前已发放" : "推荐奖励已发放并计入活动预算",
      "success",
    );
    await onChanged();
  };

  const submit = async () => {
    if (campaign === null || guard.busy) return;
    const parsed = MarketingReferralRewardIssueInputSchema.safeParse({
      campaign_id: campaign.campaign_id,
      expected_version: campaign.version,
      referrer_customer_id: referrerId.trim(),
      referred_customer_id: referredId.trim(),
      qualifying_order_id: orderId.trim(),
      coupon_definition_id: couponId.trim(),
      reason: reason.trim(),
    });
    if (!parsed.success) {
      toast.push("请填写不同的推荐双方、已结清订单、奖励券定义和原因", "error");
      return;
    }
    const attempt = guard.begin("marketing.referral.reward.issue");
    const epoch = guard.bind(attempt, marketingReferralAuthorityKey(scopeKey, parsed.data));
    if (epoch === null) {
      guard.finishAttempt(attempt);
      return;
    }
    pendingEpoch.current = null;
    setPending(null);
    try {
      const response = await commandClient.execute<unknown>(
        "marketing.referral.reward.issue",
        parsed.data,
      );
      if (!guard.current(epoch)) return;
      if (response.ok) return await apply(epoch, response.data);
      const summary = response.error.detail?.summary;
      const ref = response.error.detail?.confirm_ref;
      if (
        response.error.code === "POLICY_STEP_UP_REQUIRED" &&
        typeof ref === "string" &&
        summary?.kind === "marketing_referral_reward" &&
        marketingReferralSummaryMatches(summary, parsed.data)
      ) {
        pendingEpoch.current = epoch;
        setPending(Object.freeze({ ref, summary }));
        return;
      }
      toast.push(response.error.message ?? response.error.code, "error");
    } catch {
      if (guard.current(epoch)) {
        toast.push("推荐奖励发放失败，券账本和活动预算未部分更新", "error");
      }
    } finally {
      guard.finish(epoch);
    }
  };

  const resume = async () => {
    const epoch = pendingEpoch.current;
    if (pending === null || epoch === null || guard.busy || !guard.activate(epoch)) return;
    try {
      const response = await commandClient.execute<unknown>(
        "marketing.referral.reward.issue",
        {},
        { confirmRef: pending.ref },
      );
      if (!guard.current(epoch)) return;
      if (!response.ok) {
        toast.push(response.error.message ?? response.error.code, "error");
        return;
      }
      await apply(epoch, response.data);
    } catch {
      if (guard.current(epoch)) toast.push("无法完成推荐奖励复核，请重新发起", "error");
    } finally {
      guard.finish(epoch);
    }
  };

  return (
    <section className="ld-owner-management lg-card" aria-label="推荐奖励">
      <header className="ld-owner-management__header">
        <div>
          <span className="ld-owner-operations__eyebrow">R4 · 结清订单资格 · 活动预算</span>
          <h2>推荐奖励</h2>
          <p>奖励发给推荐人的会员账户；被推荐人每个活动最多获得一次推荐归因。</p>
        </div>
      </header>
      <div className="ld-owner-management__form">
        <Input
          name="referral-referrer"
          label="推荐人顾客 ID"
          value={referrerId}
          disabled={guard.busy}
          onChange={(event) => {
            invalidate();
            setReferrerId(event.target.value);
          }}
        />
        <Input
          name="referral-referred"
          label="被推荐人顾客 ID"
          value={referredId}
          disabled={guard.busy}
          onChange={(event) => {
            invalidate();
            setReferredId(event.target.value);
          }}
        />
        <Input
          name="referral-order"
          label="被推荐人结清订单 ID"
          value={orderId}
          disabled={guard.busy}
          onChange={(event) => {
            invalidate();
            setOrderId(event.target.value);
          }}
        />
        <Input
          name="referral-coupon"
          label="奖励券定义 ID"
          value={couponId}
          disabled={guard.busy}
          onChange={(event) => {
            invalidate();
            setCouponId(event.target.value);
          }}
        />
        <Input
          name="referral-reason"
          label="发放原因"
          maxLength={256}
          value={reason}
          disabled={guard.busy}
          onChange={(event) => {
            invalidate();
            setReason(event.target.value);
          }}
        />
      </div>
      <div className="ld-marketing-actions">
        <Button
          type="button"
          variant="primary"
          disabled={guard.busy || campaign === null}
          onClick={() => void submit()}
        >
          发起推荐奖励复核
        </Button>
      </div>
      {campaign === null ? <p>请先选择一个活动。</p> : null}
      <StepUpConfirmDialog
        open={activePending !== null}
        onClose={invalidate}
        authClient={authClient}
        confirmRef={activePending?.ref ?? ""}
        currentStaffId={session.session.staff_id}
        commandLabel="推荐奖励发放"
        summary={
          activePending === null ? undefined : (
            <MarketingReferralConfirmationDetails summary={activePending.summary} />
          )
        }
        onApproved={() => void resume()}
      />
    </section>
  );
}
