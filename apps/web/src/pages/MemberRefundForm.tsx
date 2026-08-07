import { Button, Input, MoneyText } from "@laundry/ui";
import { useCallback, useState } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort } from "../commands/types.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";
import { topupAmountToCents } from "./member-model.js";

export type MemberRefundFormProps = Readonly<{
  accountId: string;
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

/** Resume an R4 refund with only the server-frozen confirmation reference. */
export function resumeMemberRefund(commandClient: CommandPort, confirmRef: string) {
  return commandClient.execute("member.refund", {}, { confirmRef });
}

export function MemberRefundForm({
  accountId,
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
  const [pendingRef, setPendingRef] = useState<string | null>(null);

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
    if (trimmedReason.length === 0) {
      toast.push("请填写退款原因", "error");
      return;
    }
    setBusy(true);
    try {
      const result = await commandClient.execute("member.refund", {
        account_id: accountId,
        amount_cents: amountCents,
        tender,
        reason: trimmedReason,
      });
      if (result.ok) {
        await finish();
        return;
      }
      if (isStepUpRequired(result)) {
        if (authClient === undefined || session === undefined) {
          toast.push("当前客户端无法完成现场复核", "error");
          return;
        }
        setPendingRef(result.error.detail.confirm_ref);
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
    if (pendingRef === null) return;
    setBusy(true);
    try {
      const result = await resumeMemberRefund(commandClient, pendingRef);
      if (!result.ok) {
        toast.push(result.error.message ?? result.error.code, "error");
        return;
      }
      setPendingRef(null);
      await finish();
    } finally {
      setBusy(false);
    }
  }, [commandClient, finish, pendingRef, toast]);

  if (session?.role !== "admin") return null;

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
      {pendingRef !== null && authClient !== undefined ? (
        <StepUpConfirmDialog
          open
          onClose={() => setPendingRef(null)}
          authClient={authClient}
          confirmRef={pendingRef}
          currentStaffId={session.session.staff_id}
          commandLabel="退还储值本金"
          requiredApproverRole="admin"
          onApproved={() => void resume()}
        />
      ) : null}
    </div>
  );
}
