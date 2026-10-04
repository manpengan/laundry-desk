import { useEffect, useRef, useState } from "react";
import {
  ChannelRefundInputSchema,
  type ChannelIntent,
  type ChannelRefundInput,
} from "@laundry/contracts";
import { Button, MoneyInput, MoneyText } from "@laundry/ui";
import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import type { CommandPort } from "../commands/types.js";
import { isStepUpRequired } from "../commands/command-client.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";
const reasons = {
  customer_request: "顾客申请",
  duplicate_payment: "重复付款",
  service_cancelled: "服务取消",
  other: "其他",
};
export function PaymentChannelRefund({
  intent,
  authClient,
  commandClient,
  session,
  onSubmitted,
}: Readonly<{
  intent: ChannelIntent;
  authClient: AuthClient;
  commandClient: CommandPort;
  session: SessionView;
  onSubmitted: () => void;
}>) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState<ChannelRefundInput["reason"]>("customer_request");
  const [pending, setPending] = useState<Readonly<{
    confirmRef: string;
    body: ChannelRefundInput;
  }> | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const generation = useRef(0),
    alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    ++generation.current;
    return () => {
      alive.current = false;
      ++generation.current;
    };
  }, []);
  const execute = async (confirmRef?: string) => {
    if (!alive.current || busy) return;
    const parsed = ChannelRefundInputSchema.safeParse({
      intent_id: intent.intent_id,
      amount_cents: Number(amount),
      reason,
    });
    if (!confirmRef && (!parsed.success || !/^\d+$/u.test(amount))) {
      setMessage("请填写大于零的退款金额。");
      return;
    }
    const current = generation.current;
    setBusy(true);
    setMessage("");
    try {
      const result = await commandClient.execute(
        "payment.channel.refund",
        confirmRef ? {} : parsed.success ? parsed.data : {},
        confirmRef ? { confirmRef } : undefined,
      );
      if (current !== generation.current) return;
      if (result.ok) {
        setPending(null);
        setAmount("");
        setMessage("退款申请已登记。请查询渠道结果，提交成功不代表已经退款。");
        onSubmitted();
      } else if (
        !confirmRef &&
        parsed.success &&
        isStepUpRequired(result) &&
        result.error.code === "POLICY_STEP_UP_REQUIRED"
      )
        setPending({ confirmRef: result.error.detail.confirm_ref, body: parsed.data });
      else setMessage("退款未确认，请刷新退款记录核对状态；勿重复申请。");
    } catch {
      if (current === generation.current) setMessage("退款结果未知，请先查询记录再处理。");
    } finally {
      if (current === generation.current) setBusy(false);
    }
  };
  return (
    <div className="ld-panel" aria-label="原路退款">
      <h4>原路退款</h4>
      <p className="ld-panel__lead">需另一位店长现场复核；剩余可退金额及渠道结果由服务端核对。</p>
      <div className="ld-panel__grid">
        <MoneyInput
          name="channel-refund-cents"
          label="申请退款金额"
          valueFen={amount}
          onChangeFen={setAmount}
          disabled={busy || !!pending}
        />
        <label className="ld-field">
          <span className="ld-field__label">退款原因</span>
          <select
            className="ld-input"
            value={reason}
            disabled={busy || !!pending}
            onChange={(e) => {
              const parsed = ChannelRefundInputSchema.shape.reason.safeParse(e.target.value);
              if (parsed.success) setReason(parsed.data);
            }}
          >
            {Object.entries(reasons).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="ld-panel__actions">
        <Button
          variant="danger"
          disabled={busy || !!pending || !amount}
          onClick={() => void execute()}
        >
          申请渠道退款
        </Button>
      </div>
      {message && (
        <p className="ld-panel__note" role="status">
          {message}
        </p>
      )}
      {pending && (
        <StepUpConfirmDialog
          open
          authClient={authClient}
          currentStaffId={session.session.staff_id}
          confirmRef={pending.confirmRef}
          commandLabel="支付渠道原路退款"
          onClose={() => setPending(null)}
          summary={
            <p>
              申请退款 <MoneyText fen={pending.body.amount_cents} />
              ；原因：{reasons[pending.body.reason]}。复核后按此金额执行。
            </p>
          }
          onApproved={() => void execute(pending.confirmRef)}
        />
      )}
    </div>
  );
}
