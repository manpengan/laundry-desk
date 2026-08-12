import { Button, Input, useToast } from "@laundry/ui";
import {
  MarketingCouponRedemptionReverseInputSchema,
  MarketingCouponRedemptionReverseResultSchema,
  type MarketingCouponReversalConfirmationSummary,
  type MarketingCouponRedemptionReverseResult,
} from "@laundry/contracts";
import { useRef, useState } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import type { CommandPort } from "../commands/types.js";
import { unwrapQueryResult } from "../pages/customer-model.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";
import { MarketingCouponReversalConfirmationDetails } from "./MarketingCouponConfirmationDetails.js";
import {
  createMarketingCommandEpoch,
  marketingCommandEpochMatches,
  marketingReversalAuthorityKey,
  marketingReversalSummaryMatches,
} from "./marketing-coupon-preview.js";

export type OwnerMarketingCouponReversalProps = Readonly<{
  session: SessionView;
  authClient: AuthClient;
  commandClient: CommandPort;
}>;

type PendingReversal = Readonly<{
  ref: string;
  summary: MarketingCouponReversalConfirmationSummary;
}>;

export function OwnerMarketingCouponReversal({
  session,
  authClient,
  commandClient,
}: OwnerMarketingCouponReversalProps) {
  const toast = useToast();
  const [redemptionId, setRedemptionId] = useState("");
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState<PendingReversal | null>(null);
  const [result, setResult] = useState<MarketingCouponRedemptionReverseResult | null>(null);
  const [busy, setBusy] = useState(false);
  const reversalGeneration = useRef(0);
  const reversalAuthorityKey = marketingReversalAuthorityKey(redemptionId.trim(), reason.trim());
  const reversalAuthorityKeyRef = useRef(reversalAuthorityKey);
  reversalAuthorityKeyRef.current = reversalAuthorityKey;

  const invalidateReversal = () => {
    reversalGeneration.current += 1;
    setPending(null);
  };

  const apply = (value: unknown) => {
    const parsed = MarketingCouponRedemptionReverseResultSchema.safeParse(unwrapQueryResult(value));
    if (!parsed.success) throw new Error("invalid coupon reversal result");
    const next = Object.freeze(parsed.data);
    setResult(next);
    setPending(null);
    toast.push(next.changed ? "核销已冲正，优惠券恢复可用" : "该核销此前已冲正", "success");
  };

  const submit = async () => {
    if (busy) return;
    const parsed = MarketingCouponRedemptionReverseInputSchema.safeParse({
      redemption_id: redemptionId.trim(),
      reason: reason.trim(),
    });
    if (!parsed.success) {
      toast.push("请填写有效核销 ID 和冲正原因", "error");
      return;
    }
    const request = createMarketingCommandEpoch(
      ++reversalGeneration.current,
      marketingReversalAuthorityKey(parsed.data.redemption_id, parsed.data.reason),
    );
    setBusy(true);
    setResult(null);
    try {
      const response = await commandClient.execute<unknown>(
        "marketing.coupon.redemption.reverse",
        parsed.data,
      );
      if (
        !marketingCommandEpochMatches(
          request,
          reversalGeneration.current,
          reversalAuthorityKeyRef.current,
        )
      ) {
        return;
      }
      if (response.ok) {
        apply(response.data);
        return;
      }
      const confirmRef = response.error.detail?.confirm_ref;
      const summary = response.error.detail?.summary;
      if (
        response.error.code === "POLICY_STEP_UP_REQUIRED" &&
        typeof confirmRef === "string" &&
        summary?.kind === "marketing_coupon_redemption_reversal"
      ) {
        if (
          !marketingReversalSummaryMatches(summary, parsed.data.redemption_id, parsed.data.reason)
        ) {
          toast.push("服务端冲正确认内容与当前输入不一致，请重新发起", "error");
          return;
        }
        setPending(
          Object.freeze({
            ref: confirmRef,
            summary,
          }),
        );
        return;
      }
      toast.push(response.error.message ?? response.error.code, "error");
    } catch {
      toast.push("核销冲正失败，订单和券账本未部分更新", "error");
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    if (pending === null || busy) return;
    setBusy(true);
    try {
      const response = await commandClient.execute<unknown>(
        "marketing.coupon.redemption.reverse",
        {},
        { confirmRef: pending.ref },
      );
      if (!response.ok) {
        toast.push(response.error.message ?? response.error.code, "error");
        return;
      }
      apply(response.data);
    } catch {
      toast.push("无法完成核销冲正确认，请重新操作", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ld-owner-management lg-card" aria-label="优惠券核销冲正">
      <header className="ld-owner-management__header">
        <div>
          <span className="ld-owner-operations__eyebrow">R4 · 双向审计 · 仅未付款开放订单</span>
          <h2>核销冲正</h2>
          <p>仅可冲正活动发放券；原核销和冲正证据都会保留。</p>
        </div>
      </header>
      <div className="ld-owner-management__form">
        <Input
          name="marketing-redemption-id"
          label="核销 ID"
          disabled={busy}
          value={redemptionId}
          onChange={(event) => {
            invalidateReversal();
            setRedemptionId(event.target.value);
            setResult(null);
          }}
        />
        <Input
          name="marketing-reversal-reason"
          label="冲正原因"
          maxLength={256}
          disabled={busy}
          value={reason}
          onChange={(event) => {
            invalidateReversal();
            setReason(event.target.value);
          }}
        />
      </div>
      <div className="ld-marketing-actions">
        <Button type="button" variant="danger" disabled={busy} onClick={() => void submit()}>
          发起冲正复核
        </Button>
      </div>
      {result === null ? null : (
        <p className="ld-marketing-preview" role="status">
          {result.changed ? "已冲正" : "已存在冲正"} · 订单 {result.order_id} · ¥
          {(result.reversed_discount_cents / 100).toFixed(2)}
        </p>
      )}
      <StepUpConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        authClient={authClient}
        confirmRef={pending?.ref ?? ""}
        currentStaffId={session.session.staff_id}
        commandLabel="优惠券核销冲正"
        summary={
          pending === null ? undefined : (
            <MarketingCouponReversalConfirmationDetails summary={pending.summary} />
          )
        }
        onApproved={() => void resume()}
      />
    </section>
  );
}
