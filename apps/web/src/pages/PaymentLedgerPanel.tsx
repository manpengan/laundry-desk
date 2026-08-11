import { Button, Dialog, Input, MoneyText, useToast } from "@laundry/ui";
import { useCallback, useEffect, useRef, useState } from "react";

import type { AuthClient } from "../auth/AuthClient.js";
import type { SessionView } from "../auth/types.js";
import { isStepUpRequired } from "../commands/command-client.js";
import type { CommandPort, QueryPort } from "../commands/types.js";
import { StepUpConfirmDialog } from "../shell/StepUpConfirmDialog.js";
import {
  buildPaymentRefundBody,
  paymentKindLabel,
  paymentMethodLabel,
  readPaymentLedger,
  resumePaymentRefund,
  type PaymentLedgerRowView,
  type PaymentLedgerView,
  type PaymentRefundBody,
} from "./payment-ledger-model.js";

type PendingRefund = Readonly<{
  confirmRef: string;
  body: PaymentRefundBody;
}>;

export type PaymentLedgerPanelProps = Readonly<{
  orderId: string;
  queryClient: QueryPort;
  commandClient?: CommandPort;
  authClient?: AuthClient;
  session?: SessionView;
  onCompleted: () => void | Promise<void>;
}>;

export function PaymentLedgerPanel({
  orderId,
  queryClient,
  commandClient,
  authClient,
  session,
  onCompleted,
}: PaymentLedgerPanelProps) {
  const toast = useToast();
  const requestRef = useRef(0);
  const [ledger, setLedger] = useState<PaymentLedgerView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<PaymentLedgerRowView | null>(null);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingRefund | null>(null);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await queryClient.execute<unknown>("payment.ledger.list", {
        order_id: orderId,
      });
      if (request !== requestRef.current) return;
      if (!result.ok) {
        setLedger(null);
        setError(result.error.message ?? result.error.code);
        return;
      }
      const parsed = readPaymentLedger(result.data);
      if (parsed === null || parsed.order_id !== orderId) {
        setLedger(null);
        setError("支付流水响应格式错误");
        return;
      }
      setLedger(parsed);
    } catch {
      if (request === requestRef.current) {
        setLedger(null);
        setError("加载支付流水失败");
      }
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [orderId, queryClient]);

  useEffect(() => {
    setLedger(null);
    setTarget(null);
    setPending(null);
    void load();
    return () => {
      requestRef.current += 1;
    };
  }, [load]);

  const finish = useCallback(async () => {
    setTarget(null);
    setPending(null);
    setAmount("");
    setReason("");
    toast.push("退款已追加到支付流水", "success");
    try {
      await onCompleted();
      await load();
    } catch {
      toast.push("退款已成功，但订单详情刷新失败，请手动刷新", "error");
    }
  }, [load, onCompleted, toast]);

  const submit = useCallback(async () => {
    if (target === null || commandClient === undefined) return;
    const built = buildPaymentRefundBody(orderId, target, amount, reason);
    if (!built.ok) {
      toast.push(built.message, "error");
      return;
    }
    setBusy(true);
    try {
      const result = await commandClient.execute("payment.refund", built.body);
      if (result.ok) {
        await finish();
        return;
      }
      if (isStepUpRequired(result) && result.error.code === "POLICY_STEP_UP_REQUIRED") {
        if (authClient === undefined || session === undefined) {
          toast.push("当前客户端无法完成另一位店长现场复核", "error");
          return;
        }
        setPending(
          Object.freeze({ confirmRef: result.error.detail.confirm_ref, body: built.body }),
        );
        setTarget(null);
        return;
      }
      toast.push(result.error.message ?? result.error.code, "error");
    } catch {
      toast.push("无法提交退款，请检查服务连接", "error");
    } finally {
      setBusy(false);
    }
  }, [amount, authClient, commandClient, finish, orderId, reason, session, target, toast]);

  const resume = useCallback(async () => {
    if (pending === null || commandClient === undefined) return;
    setBusy(true);
    try {
      const result = await resumePaymentRefund(commandClient, pending.confirmRef);
      if (!result.ok) {
        toast.push(result.error.message ?? result.error.code, "error");
        return;
      }
      await finish();
    } catch {
      toast.push("无法完成退款复核，请检查服务连接", "error");
    } finally {
      setBusy(false);
    }
  }, [commandClient, finish, pending, toast]);

  const canRefund =
    session?.role === "admin" && commandClient !== undefined && authClient !== undefined;

  return (
    <section className="ld-payment-ledger" aria-label="支付流水" data-testid="payment-ledger">
      <div className="ld-order-detail__section-head">
        <h3 className="ld-order-detail__section-title">支付流水</h3>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          onClick={() => void load()}
          disabled={loading}
        >
          刷新
        </Button>
      </div>
      {loading ? <p className="ld-payment-ledger__empty">流水加载中…</p> : null}
      {error !== null ? (
        <p className="ld-payment-ledger__error" role="alert">
          流水暂时无法加载：{error}
        </p>
      ) : null}
      {!loading && error === null && ledger?.payments.length === 0 ? (
        <p className="ld-payment-ledger__empty">暂无支付流水</p>
      ) : null}
      {ledger === null || ledger.payments.length === 0 ? null : (
        <ul className="ld-payment-ledger__list">
          {ledger.payments.map((payment) => (
            <li
              key={payment.payment_id}
              className="ld-payment-ledger__row"
              data-testid="payment-ledger-row"
            >
              <div className="ld-payment-ledger__main">
                <strong>{paymentKindLabel(payment.kind)}</strong>
                <span>{paymentMethodLabel(payment.method)}</span>
                <span>{payment.active ? "有效" : "已冲正"}</span>
              </div>
              <div className="ld-payment-ledger__money">
                <span>{payment.signed_cents < 0 ? "−" : "+"}</span>
                <MoneyText fen={Math.abs(payment.signed_cents)} size="sm" />
              </div>
              {payment.note === null ? null : (
                <p className="ld-payment-ledger__note">{payment.note}</p>
              )}
              {payment.refundable_cents > 0 ? (
                <div className="ld-payment-ledger__refund">
                  <span>
                    服务端可退 <MoneyText fen={payment.refundable_cents} size="sm" />
                  </span>
                  {canRefund ? (
                    <Button
                      variant="danger"
                      size="sm"
                      type="button"
                      onClick={() => {
                        setTarget(payment);
                        setAmount(String(payment.refundable_cents));
                        setReason("");
                      }}
                      data-testid="payment-refund-open-btn"
                    >
                      退款
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className="ld-payment-ledger__hint">
        流水只追加不修改；可退金额和原支付方式均由服务端账本确定。
      </p>

      <Dialog
        open={target !== null}
        title="原路退款"
        onClose={() => {
          if (!busy) setTarget(null);
        }}
        footer={
          <>
            <Button variant="ghost" type="button" onClick={() => setTarget(null)} disabled={busy}>
              取消
            </Button>
            <Button variant="danger" type="button" onClick={() => void submit()} disabled={busy}>
              {busy ? "提交中…" : "申请退款"}
            </Button>
          </>
        }
      >
        {target === null ? null : (
          <div className="ld-payment-ledger__refund-form" data-testid="payment-refund-dialog">
            <p>
              原支付：{paymentMethodLabel(target.method)}；当前可退
              <MoneyText fen={target.refundable_cents} />
              。提交后需另一位店长现场 PIN 复核。
            </p>
            <Input
              name="payment-refund-amount-cents"
              label="退款金额（分）"
              inputMode="numeric"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              disabled={busy}
              data-testid="payment-refund-amount"
            />
            <Input
              name="payment-refund-reason"
              label="退款原因"
              maxLength={256}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={busy}
              data-testid="payment-refund-reason"
            />
          </div>
        )}
      </Dialog>

      {pending !== null && authClient !== undefined && session !== undefined ? (
        <StepUpConfirmDialog
          open
          onClose={() => setPending(null)}
          authClient={authClient}
          confirmRef={pending.confirmRef}
          currentStaffId={session.session.staff_id}
          commandLabel="订单原路退款"
          summary={
            <div className="ld-payment-ledger__confirmation">
              <p>
                退款 <MoneyText fen={pending.body.amount_cents} />
                ；渠道：
                {paymentMethodLabel(pending.body.method)}。
              </p>
              <p>原因：{pending.body.reason}</p>
              <p>复核后只凭服务端冻结的确认卡执行，不重新提交可变字段。</p>
            </div>
          }
          onApproved={() => void resume()}
        />
      ) : null}
    </section>
  );
}
