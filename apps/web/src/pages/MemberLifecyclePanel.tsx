import { Button, Dialog, Input, MoneyText } from "@laundry/ui";
import { useCallback, useState } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort } from "../commands/types.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";
import type { CustomerRowView } from "./customer-model.js";
import {
  buildMemberLifecycleBody,
  MEMBER_LIFECYCLE_COMMANDS,
  requestMemberLifecycle,
  resumeMemberLifecycle,
  type MemberCloseBody,
  type MemberLifecycleAction,
  type MemberLifecyclePending,
} from "./member-lifecycle.js";
import type { MemberAccountSummary, MemberTenderView } from "./member-model.js";

export type MemberLifecyclePanelProps = Readonly<{
  customer: CustomerRowView;
  account: MemberAccountSummary;
  commandClient: CommandPort;
  authClient?: AuthClient;
  session?: SessionView;
  toast: Readonly<{ push: (message: string, kind: "success" | "error") => void }>;
  onCompleted: () => Promise<void>;
}>;

const CLOSE_TENDERS = Object.freeze([
  { value: "cash", label: "现金" },
  { value: "wechat", label: "微信" },
  { value: "alipay", label: "支付宝" },
  { value: "other", label: "其他" },
] as const);

const ACTION_COPY = Object.freeze({
  freeze: Object.freeze({ title: "挂失并冻结会员账户", button: "挂失冻结" }),
  unfreeze: Object.freeze({ title: "解除会员账户挂失", button: "解除挂失" }),
  close: Object.freeze({ title: "退卡并永久销户", button: "退卡销户" }),
});

function tenderLabel(tender: MemberTenderView | null): string {
  if (tender === null) return "无需退款";
  return CLOSE_TENDERS.find((item) => item.value === tender)?.label ?? "其他";
}

function statusLabel(status: MemberAccountSummary["status"]): string {
  if (status === "active") return "正常";
  if (status === "frozen") return "挂失冻结";
  return "已销户";
}

/** Close cards render only the values frozen into the pending command body. */
export function memberLifecycleDisplaySnapshot(
  pending: MemberLifecyclePending,
  account: MemberAccountSummary,
): Readonly<{ status: MemberAccountSummary["status"]; balanceCents: number }> {
  if (pending.action !== "close") {
    return Object.freeze({ status: account.status, balanceCents: account.balance_cents });
  }
  const body = pending.body as MemberCloseBody;
  return Object.freeze({
    status: body.expected_status,
    balanceCents: body.expected_principal_cents + body.expected_bonus_cents,
  });
}

function actionSummary(
  pending: MemberLifecyclePending,
  customer: CustomerRowView,
  account: MemberAccountSummary,
) {
  const closeBody = pending.action === "close" ? (pending.body as MemberCloseBody) : null;
  const display = memberLifecycleDisplaySnapshot(pending, account);
  return (
    <div className="ld-member-confirmation" data-testid="member-lifecycle-summary">
      <p>
        顾客：{customer.name ?? "未填写姓名"}（{customer.phone}）
      </p>
      <p>
        当前状态：{statusLabel(display.status)}；当前余额 <MoneyText fen={display.balanceCents} />
      </p>
      <p>操作原因：{pending.body.reason}</p>
      {pending.action === "freeze" ? (
        <p>确认后账户将禁止充值、余额消费和普通退款，管理员解除挂失前不会恢复。</p>
      ) : pending.action === "unfreeze" ? (
        <p>确认后账户将恢复充值和余额消费，请先核验顾客身份。</p>
      ) : closeBody === null ? null : (
        <>
          <p>
            退还本金 <MoneyText fen={closeBody.expected_principal_cents} />
            ，退款渠道：
            {tenderLabel(closeBody.refund_tender)}
          </p>
          <p>
            赠款销户作废 <MoneyText fen={closeBody.expected_bonus_cents} />
            ；销户后余额为零，且不能重新开通。
          </p>
        </>
      )}
    </div>
  );
}

export function MemberLifecyclePanel({
  customer,
  account,
  commandClient,
  authClient,
  session,
  toast,
  onCompleted,
}: MemberLifecyclePanelProps) {
  const [draftAction, setDraftAction] = useState<MemberLifecycleAction | null>(null);
  const [reason, setReason] = useState("");
  const [refundTender, setRefundTender] = useState<MemberTenderView>("cash");
  const [pending, setPending] = useState<MemberLifecyclePending | null>(null);
  const [busy, setBusy] = useState(false);
  const isAdmin = session?.role === "admin";

  const resetDraft = useCallback(() => {
    setDraftAction(null);
    setReason("");
    setRefundTender("cash");
  }, []);

  const finish = useCallback(
    async (action: MemberLifecycleAction) => {
      setPending(null);
      resetDraft();
      toast.push(
        action === "freeze"
          ? "会员账户已挂失冻结"
          : action === "unfreeze"
            ? "会员账户已解除挂失"
            : "会员账户已退卡销户",
        "success",
      );
      await onCompleted();
    },
    [onCompleted, resetDraft, toast],
  );

  const submit = useCallback(async () => {
    if (draftAction === null) return;
    const body = buildMemberLifecycleBody(draftAction, account, reason, refundTender);
    if (body === null) {
      toast.push("请填写 1–256 字操作原因，并刷新确认账户状态", "error");
      return;
    }
    setBusy(true);
    try {
      const result = await requestMemberLifecycle(commandClient, draftAction, body);
      if (result.ok) {
        await finish(draftAction);
        return;
      }
      if (!isStepUpRequired(result)) {
        toast.push(result.error.message ?? result.error.code, "error");
        return;
      }
      const expectedCode =
        draftAction === "close" ? "POLICY_STEP_UP_REQUIRED" : "POLICY_CONFIRMATION_REQUIRED";
      if (result.error.code !== expectedCode) {
        toast.push(result.error.message ?? result.error.code, "error");
        return;
      }
      if (draftAction === "close" && (authClient === undefined || session === undefined)) {
        toast.push("当前客户端无法完成另一位管理员现场复核", "error");
        return;
      }
      setPending(
        Object.freeze({
          action: draftAction,
          command: MEMBER_LIFECYCLE_COMMANDS[draftAction],
          body,
          confirmRef: result.error.detail.confirm_ref,
          gate: draftAction === "close" ? "step_up" : "confirm",
        }),
      );
      setDraftAction(null);
    } finally {
      setBusy(false);
    }
  }, [
    account,
    authClient,
    commandClient,
    draftAction,
    finish,
    reason,
    refundTender,
    session,
    toast,
  ]);

  const resume = useCallback(
    async (snapshot: MemberLifecyclePending) => {
      setBusy(true);
      try {
        const result = await resumeMemberLifecycle(
          commandClient,
          snapshot.command,
          snapshot.confirmRef,
        );
        if (!result.ok) {
          setPending(null);
          toast.push(result.error.message ?? result.error.code, "error");
          await onCompleted();
          return;
        }
        await finish(snapshot.action);
      } finally {
        setBusy(false);
      }
    },
    [commandClient, finish, onCompleted, toast],
  );

  const openAction = useCallback((action: MemberLifecycleAction) => {
    setReason("");
    setRefundTender("cash");
    setDraftAction(action);
  }, []);

  if (session === undefined || account.status === "closed") return null;
  const canFreeze = account.status === "active";
  const canUnfreeze = isAdmin && account.status === "frozen";

  return (
    <div className="ld-member-lifecycle" data-testid="member-lifecycle">
      <div className="ld-member-lifecycle__actions">
        {canFreeze ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => openAction("freeze")}
            disabled={busy}
            data-testid="member-freeze"
          >
            挂失冻结
          </Button>
        ) : null}
        {canUnfreeze ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => openAction("unfreeze")}
            disabled={busy}
            data-testid="member-unfreeze"
          >
            解除挂失
          </Button>
        ) : null}
        {isAdmin ? (
          <Button
            type="button"
            variant="danger"
            onClick={() => openAction("close")}
            disabled={busy}
            data-testid="member-close"
          >
            退卡销户
          </Button>
        ) : null}
      </div>

      <Dialog
        open={draftAction !== null}
        title={draftAction === null ? "会员账户操作" : ACTION_COPY[draftAction].title}
        onClose={() => {
          if (!busy) resetDraft();
        }}
        footer={
          <>
            <Button variant="ghost" type="button" onClick={resetDraft} disabled={busy}>
              取消
            </Button>
            <Button
              variant={draftAction === "close" ? "danger" : "primary"}
              type="button"
              onClick={() => void submit()}
              disabled={busy}
            >
              {busy ? "提交中…" : "继续确认"}
            </Button>
          </>
        }
      >
        {draftAction === null ? null : (
          <div className="ld-member-lifecycle__form">
            <p>
              当前状态：{statusLabel(account.status)}；余额{" "}
              <MoneyText fen={account.balance_cents} />
            </p>
            {draftAction === "close" && account.principal_cents > 0 ? (
              <label className="ld-member-panel__method">
                <span>本金退款渠道</span>
                <select
                  value={refundTender}
                  onChange={(event) => setRefundTender(event.target.value as MemberTenderView)}
                  disabled={busy}
                  data-testid="member-close-tender"
                >
                  {CLOSE_TENDERS.map((item) => (
                    <option key={item.value} value={item.value}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <Input
              label="操作原因"
              value={reason}
              maxLength={256}
              onChange={(event) => setReason(event.target.value)}
              disabled={busy}
              data-testid="member-lifecycle-reason"
            />
          </div>
        )}
      </Dialog>

      <Dialog
        open={pending?.gate === "confirm"}
        title={pending === null ? "确认会员账户操作" : `确认${ACTION_COPY[pending.action].button}`}
        onClose={() => {
          if (!busy) setPending(null);
        }}
        footer={
          <>
            <Button variant="ghost" type="button" onClick={() => setPending(null)} disabled={busy}>
              取消
            </Button>
            <Button
              variant="primary"
              type="button"
              onClick={() => (pending === null ? undefined : void resume(pending))}
              disabled={busy}
              data-testid="member-lifecycle-confirm"
            >
              {busy ? "执行中…" : "确认执行"}
            </Button>
          </>
        }
      >
        {pending === null ? null : actionSummary(pending, customer, account)}
      </Dialog>

      {pending?.gate === "step_up" && authClient !== undefined ? (
        <StepUpConfirmDialog
          open
          onClose={() => setPending(null)}
          authClient={authClient}
          confirmRef={pending.confirmRef}
          currentStaffId={session.session.staff_id}
          commandLabel="退卡并永久销户"
          requiredApproverRole="admin"
          summary={actionSummary(pending, customer, account)}
          onApproved={() => void resume(pending)}
        />
      ) : null}
    </div>
  );
}
