import {
  MarketingGroupBuyVoucherRedeemInputSchema,
  MarketingGroupBuyVoucherRedeemResultSchema,
  MarketingGroupBuyVoucherRegisterInputSchema,
  MarketingGroupBuyVoucherRegisterResultSchema,
} from "@laundry/contracts";
import { Button, Input, useToast } from "@laundry/ui";
import { useEffect, useRef, useState } from "react";

import { unwrapQueryResult } from "../pages/customer-model.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";
import { prepareGroupBuyCode } from "./group-buy-code.js";
import {
  MarketingGroupBuyRedemptionDetails,
  MarketingGroupBuyRegistrationDetails,
} from "./MarketingExtensionConfirmationDetails.js";
import {
  marketingExtensionScopeKey,
  marketingGroupBuyRedemptionAuthorityKey,
  marketingGroupBuyRedemptionSummaryMatches,
  marketingGroupBuyRegistrationAuthorityKey,
  marketingGroupBuyRegistrationSummaryMatches,
  type MarketingExtensionEpoch,
} from "./marketing-extension-command.js";
import {
  yuanToCents,
  type GroupBuyPending as Pending,
  type OwnerMarketingGroupBuyProps,
} from "./marketing-group-buy-ui.js";
import { useMarketingExtensionGuard } from "./use-marketing-extension-guard.js";

export type { OwnerMarketingGroupBuyProps } from "./marketing-group-buy-ui.js";

export function OwnerMarketingGroupBuy({
  session,
  authClient,
  commandClient,
}: OwnerMarketingGroupBuyProps) {
  const toast = useToast();
  const [provider, setProvider] = useState<"meituan" | "douyin" | "wechat" | "other">("meituan");
  const [externalRef, setExternalRef] = useState("");
  const [registrationCode, setRegistrationCode] = useState("");
  const [label, setLabel] = useState("");
  const [faceYuan, setFaceYuan] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [registrationReason, setRegistrationReason] = useState("");
  const [redemptionCode, setRedemptionCode] = useState("");
  const [orderId, setOrderId] = useState("");
  const [redemptionReason, setRedemptionReason] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const scopeKey = marketingExtensionScopeKey(session, "group-buy");
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
  const apply = (epoch: MarketingExtensionEpoch, action: Pending["action"], value: unknown) => {
    if (!guard.current(epoch)) return;
    if (action === "marketing.group_buy.voucher.register") {
      const parsed = MarketingGroupBuyVoucherRegisterResultSchema.safeParse(
        unwrapQueryResult(value),
      );
      if (!parsed.success) throw new Error("invalid group-buy registration result");
      if (!guard.current(epoch)) return;
      toast.push(parsed.data.voucher.replayed ? "团购券此前已登记" : "团购券已登记", "success");
      setRegistrationCode("");
    } else {
      const parsed = MarketingGroupBuyVoucherRedeemResultSchema.safeParse(unwrapQueryResult(value));
      if (!parsed.success) throw new Error("invalid group-buy redemption result");
      if (!guard.current(epoch)) return;
      toast.push(parsed.data.redemption.replayed ? "团购券此前已核销" : "团购券已核销", "success");
      setRedemptionCode("");
    }
    pendingEpoch.current = null;
    setPending(null);
  };

  const register = async () => {
    if (guard.busy) return;
    const action = "marketing.group_buy.voucher.register" as const;
    const attempt = guard.begin(action);
    const rawCode = registrationCode;
    const requestValues = Object.freeze({
      provider,
      externalRef,
      label,
      faceYuan,
      expiresAt,
      reason: registrationReason,
    });
    pendingEpoch.current = null;
    setPending(null);
    let epoch: MarketingExtensionEpoch | null = null;
    try {
      const prepared = await prepareGroupBuyCode(rawCode);
      if (!guard.attemptCurrent(attempt)) return;
      let expiry = "";
      try {
        expiry = new Date(requestValues.expiresAt).toISOString();
      } catch {
        // The schema below produces the single user-facing validation result.
      }
      const parsed = MarketingGroupBuyVoucherRegisterInputSchema.safeParse({
        provider: requestValues.provider,
        external_order_ref: requestValues.externalRef.trim(),
        voucher_code_digest: prepared?.digest,
        voucher_code_last4: prepared?.last4,
        label: requestValues.label.trim(),
        face_value_cents: yuanToCents(requestValues.faceYuan),
        expires_at: expiry,
        reason: requestValues.reason.trim(),
      });
      if (!parsed.success || prepared === null) {
        toast.push("请填写至少 24 位高熵券码、平台订单、面值、有效期和原因", "error");
        return;
      }
      epoch = guard.bind(attempt, marketingGroupBuyRegistrationAuthorityKey(scopeKey, parsed.data));
      if (epoch === null) return;
      const response = await commandClient.execute<unknown>(action, parsed.data);
      if (!guard.current(epoch)) return;
      if (response.ok) return apply(epoch, action, response.data);
      const summary = response.error.detail?.summary;
      const ref = response.error.detail?.confirm_ref;
      if (
        response.error.code === "POLICY_STEP_UP_REQUIRED" &&
        typeof ref === "string" &&
        summary?.kind === "marketing_group_buy_registration" &&
        marketingGroupBuyRegistrationSummaryMatches(summary, parsed.data)
      ) {
        setRegistrationCode("");
        pendingEpoch.current = epoch;
        setPending(Object.freeze({ action, ref, summary }));
        return;
      }
      toast.push(response.error.message ?? response.error.code, "error");
    } catch {
      if (epoch === null ? guard.attemptCurrent(attempt) : guard.current(epoch)) {
        toast.push("团购券登记失败，券码未写入服务端", "error");
      }
    } finally {
      if (epoch === null) guard.finishAttempt(attempt);
      else guard.finish(epoch);
    }
  };

  const redeem = async () => {
    if (guard.busy) return;
    const action = "marketing.group_buy.voucher.redeem" as const;
    const attempt = guard.begin(action);
    const rawCode = redemptionCode;
    const requestOrderId = orderId;
    const requestReason = redemptionReason;
    pendingEpoch.current = null;
    setPending(null);
    let epoch: MarketingExtensionEpoch | null = null;
    try {
      const prepared = await prepareGroupBuyCode(rawCode);
      if (!guard.attemptCurrent(attempt)) return;
      const parsed = MarketingGroupBuyVoucherRedeemInputSchema.safeParse({
        voucher_code_digest: prepared?.digest,
        order_id: requestOrderId.trim(),
        reason: requestReason.trim(),
      });
      if (!parsed.success || prepared === null) {
        toast.push("请填写有效团购券码、开放未付款订单 ID 和核销原因", "error");
        return;
      }
      epoch = guard.bind(attempt, marketingGroupBuyRedemptionAuthorityKey(scopeKey, parsed.data));
      if (epoch === null) return;
      const response = await commandClient.execute<unknown>(action, parsed.data);
      if (!guard.current(epoch)) return;
      if (response.ok) return apply(epoch, action, response.data);
      const summary = response.error.detail?.summary;
      const ref = response.error.detail?.confirm_ref;
      if (
        response.error.code === "POLICY_STEP_UP_REQUIRED" &&
        typeof ref === "string" &&
        summary?.kind === "marketing_group_buy_redemption" &&
        marketingGroupBuyRedemptionSummaryMatches(summary, parsed.data, prepared.last4)
      ) {
        setRedemptionCode("");
        pendingEpoch.current = epoch;
        setPending(Object.freeze({ action, ref, summary }));
        return;
      }
      toast.push(response.error.message ?? response.error.code, "error");
    } catch {
      if (epoch === null ? guard.attemptCurrent(attempt) : guard.current(epoch)) {
        toast.push("团购券核销失败，订单金额和核销证据未部分更新", "error");
      }
    } finally {
      if (epoch === null) guard.finishAttempt(attempt);
      else guard.finish(epoch);
    }
  };

  const resume = async () => {
    const epoch = pendingEpoch.current;
    if (pending === null || epoch === null || guard.busy || !guard.activate(epoch)) return;
    const current = pending;
    try {
      const response = await commandClient.execute<unknown>(
        current.action,
        {},
        { confirmRef: current.ref },
      );
      if (!guard.current(epoch)) return;
      if (!response.ok) {
        toast.push(response.error.message ?? response.error.code, "error");
        return;
      }
      apply(epoch, current.action, response.data);
    } catch {
      if (guard.current(epoch)) toast.push("无法完成团购券复核，请重新发起", "error");
    } finally {
      guard.finish(epoch);
    }
  };

  return (
    <section className="ld-owner-management lg-card" aria-label="团购券登记与核销">
      <header className="ld-owner-management__header">
        <div>
          <span className="ld-owner-operations__eyebrow">R4 · 单次核销 · 摘要存储</span>
          <h2>团购券</h2>
          <p>原始券码仅在本机生成域分离摘要；服务端、确认卡和审计均不保存原码。</p>
        </div>
      </header>
      <h3>登记外部平台券</h3>
      <div className="ld-owner-management__form">
        <label>
          <span>平台</span>
          <select
            value={provider}
            disabled={guard.busy}
            onChange={(event) => {
              invalidate();
              setProvider(event.target.value as typeof provider);
            }}
          >
            <option value="meituan">美团</option>
            <option value="douyin">抖音</option>
            <option value="wechat">微信</option>
            <option value="other">其他</option>
          </select>
        </label>
        <Input
          name="group-buy-external-ref"
          label="平台订单号"
          value={externalRef}
          disabled={guard.busy}
          onChange={(event) => {
            invalidate();
            setExternalRef(event.target.value);
          }}
        />
        <Input
          name="group-buy-register-code"
          label="高熵券码"
          type="password"
          autoComplete="off"
          value={registrationCode}
          disabled={guard.busy}
          onChange={(event) => {
            invalidate();
            setRegistrationCode(event.target.value);
          }}
        />
        <Input
          name="group-buy-label"
          label="券名称"
          value={label}
          maxLength={64}
          disabled={guard.busy}
          onChange={(event) => {
            invalidate();
            setLabel(event.target.value);
          }}
        />
        <Input
          name="group-buy-face"
          label="面值（元）"
          inputMode="decimal"
          value={faceYuan}
          disabled={guard.busy}
          onChange={(event) => {
            invalidate();
            setFaceYuan(event.target.value);
          }}
        />
        <Input
          name="group-buy-expiry"
          label="有效期至"
          type="datetime-local"
          value={expiresAt}
          disabled={guard.busy}
          onChange={(event) => {
            invalidate();
            setExpiresAt(event.target.value);
          }}
        />
        <Input
          name="group-buy-register-reason"
          label="登记原因"
          maxLength={256}
          value={registrationReason}
          disabled={guard.busy}
          onChange={(event) => {
            invalidate();
            setRegistrationReason(event.target.value);
          }}
        />
      </div>
      <div className="ld-marketing-actions">
        <Button
          type="button"
          variant="primary"
          disabled={guard.busy}
          onClick={() => void register()}
        >
          发起登记复核
        </Button>
      </div>
      <h3>核销到订单</h3>
      <div className="ld-owner-management__form">
        <Input
          name="group-buy-redeem-code"
          label="团购券码"
          type="password"
          autoComplete="off"
          value={redemptionCode}
          disabled={guard.busy}
          onChange={(event) => {
            invalidate();
            setRedemptionCode(event.target.value);
          }}
        />
        <Input
          name="group-buy-order"
          label="开放未付款订单 ID"
          value={orderId}
          disabled={guard.busy}
          onChange={(event) => {
            invalidate();
            setOrderId(event.target.value);
          }}
        />
        <Input
          name="group-buy-redeem-reason"
          label="核销原因"
          maxLength={256}
          value={redemptionReason}
          disabled={guard.busy}
          onChange={(event) => {
            invalidate();
            setRedemptionReason(event.target.value);
          }}
        />
      </div>
      <div className="ld-marketing-actions">
        <Button type="button" variant="danger" disabled={guard.busy} onClick={() => void redeem()}>
          发起核销复核
        </Button>
      </div>
      <StepUpConfirmDialog
        open={activePending !== null}
        onClose={invalidate}
        authClient={authClient}
        confirmRef={activePending?.ref ?? ""}
        currentStaffId={session.session.staff_id}
        commandLabel={
          activePending?.action === "marketing.group_buy.voucher.register"
            ? "团购券登记"
            : "团购券核销"
        }
        summary={
          activePending === null ? undefined : activePending.action ===
            "marketing.group_buy.voucher.register" ? (
            <MarketingGroupBuyRegistrationDetails summary={activePending.summary} />
          ) : (
            <MarketingGroupBuyRedemptionDetails summary={activePending.summary} />
          )
        }
        onApproved={() => void resume()}
      />
    </section>
  );
}
