import { Button, Input, MoneyText } from "@laundry/ui";
import { useCallback, useState } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort } from "../commands/types.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";
import {
  topupAmountToCents,
  type MemberAccountStatusView,
  type MemberTenderView,
} from "./member-model.js";

export type MemberRefundFormProps = Readonly<{
  accountId: string;
  accountStatus: MemberAccountStatusView;
  refundableCents: number;
  commandClient: CommandPort;
  authClient?: AuthClient;
  session?: SessionView;
  toast: Readonly<{ push: (message: string, kind: "success" | "error") => void }>;
  onCompleted: () => Promise<void>;
}>;

const REFUND_TENDERS = Object.freeze([
  { value: "cash", label: "现金" },
  { value: "wechat", label: "微信" },
  { value: "alipay", label: "支付宝" },
  { value: "other", label: "其他" },
] as const);

type RefundBody = Readonly<{
  account_id: string;
  amount_cents: number;
  tender: MemberTenderView;
  reason: string;
}>;

type PendingRefund = Readonly<{ ref: string; body: RefundBody }>;

function refundTenderLabel(tender: MemberTenderView): string {
  return REFUND_TENDERS.find((item) => item.value === tender)?.label ?? "其他";
}

/** Resume an R4 refund with only the server-frozen confirmation reference. */
export function resumeMemberRefund(commandClient: CommandPort, confirmRef: string) {
  return commandClient.execute("member.refund", {}, { confirmRef });
}

export function MemberRefundForm({
  accountId,
  accountStatus,
  refundableCents,
  commandClient,
  authClient,
  session,
  toast,
  onCompleted,
}: MemberRefundFormProps) {
  const [amount, setAmount] = useState("");
  const [tender, setTender] = useState("cash");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingRefund | null>(null);

  const finish = useCallback(async () => {
    setAmount("");
    setReason("");
    toast.push("储值本金已退款", "success");
    await onCompleted();
  }, [onCompleted, toast]);

  const submit = useCallback(async () => {
    const amountCents = topupAmountToCents(amount);
    const trimmedReason = reason.trim();
    if (amountCents === null || amountCents > refundableCents) {
      toast.push("退款金额必须大于 0，且不能超过可退本金", "error");
      return;
    }
    if (trimmedReason.length === 0 || trimmedReason.length > 256) {
      toast.push("请填写 1–256 字退款原因", "error");
      return;
    }
    setBusy(true);
    try {
      const body: RefundBody = Object.freeze({
        account_id: accountId,
        amount_cents: amountCents,
        tender: tender as MemberTenderView,
        reason: trimmedReason,
      });
      const result = await commandClient.execute("member.refund", body);
      if (result.ok) {
        await finish();
        return;
      }
      if (isStepUpRequired(result) && result.error.code === "POLICY_STEP_UP_REQUIRED") {
        if (authClient === undefined || session === undefined) {
          toast.push("当前客户端无法完成现场复核", "error");
          return;
        }
        setPending(Object.freeze({ ref: result.error.detail.confirm_ref, body }));
        return;
      }
      toast.push(result.error.message ?? result.error.code, "error");
    } finally {
      setBusy(false);
    }
  }, [
    accountId,
    amount,
    authClient,
    commandClient,
    finish,
    reason,
    refundableCents,
    session,
    tender,
    toast,
  ]);

  const resume = useCallback(async () => {
    if (pending === null) return;
    setBusy(true);
    try {
      const result = await resumeMemberRefund(commandClient, pending.ref);
      if (!result.ok) {
        toast.push(result.error.message ?? result.error.code, "error");
        return;
      }
      setPending(null);
      await finish();
    } finally {
      setBusy(false);
    }
  }, [commandClient, finish, pending, toast]);

  if (session?.role !== "admin" || accountStatus !== "active") return null;

  return (
    <div className="ld-member-refund" data-testid="member-refund">
      <div className="ld-member-refund__head">
        <strong>退还储值本金</strong>
        <span>
          当前可退 <MoneyText fen={refundableCents} />
        </span>
      </div>
      <p className="ld-member-panel__hint">赠款不退现；退款需另一位管理员现场 PIN 复核。</p>
      <div className="ld-member-refund__form">
        <Input
          label="退款金额（元）"
          value={amount}
          inputMode="decimal"
          onChange={(event) => setAmount(event.target.value)}
          disabled={busy || refundableCents <= 0}
        />
        <label className="ld-member-panel__method">
          <span>退款方式</span>
          <select
            value={tender}
            onChange={(event) => setTender(event.target.value)}
            disabled={busy || refundableCents <= 0}
          >
            {REFUND_TENDERS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <Input
          label="退款原因"
          value={reason}
          maxLength={256}
          onChange={(event) => setReason(event.target.value)}
          disabled={busy || refundableCents <= 0}
        />
        <Button
          variant="danger"
          type="button"
          onClick={() => void submit()}
          disabled={busy || refundableCents <= 0}
        >
          确认退款
        </Button>
      </div>
      {pending !== null && authClient !== undefined ? (
        <StepUpConfirmDialog
          open
          onClose={() => setPending(null)}
          authClient={authClient}
          confirmRef={pending.ref}
          currentStaffId={session.session.staff_id}
          commandLabel="退还储值本金"
          requiredApproverRole="admin"
          summary={
            <div className="ld-member-confirmation">
              <p>
                退款本金 <MoneyText fen={pending.body.amount_cents} />
              </p>
              <p>退款渠道：{refundTenderLabel(pending.body.tender)}</p>
              <p>退款原因：{pending.body.reason}</p>
              <p>赠款不会退现；复核后将立即追加不可编辑的退款流水。</p>
            </div>
          }
          onApproved={() => void resume()}
        />
      ) : null}
    </div>
  );
}
