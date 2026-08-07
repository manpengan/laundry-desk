/** Independent counter collection / repayment against the append-only payment ledger. */

import { Button, Dialog, Input, MoneyText, useToast } from "@laundry/ui";
import { useEffect, useMemo, useState } from "react";

import type { CommandPort, QueryPort } from "../commands/types.js";
import { unwrapQueryResult } from "./customer-model.js";
import { parseMemberAccountView } from "./member-model.js";
import { parseNonNegCents, type OrderGetResult, type PaymentMethod } from "./order-form.js";
import {
  BALANCE_CHOICE,
  buildPaymentSubmission,
  submissionErrorMessage,
} from "./payment-submission.js";

export type PaymentCollectionDialogProps = Readonly<{
  open: boolean;
  order: OrderGetResult;
  commandClient: CommandPort;
  /** Omit to hide stored-value settlement (e.g. hosts without a query port). */
  queryClient?: QueryPort;
  /** Server session feature projection; false/omitted must not query or render member data. */
  memberEnabled?: boolean;
  onClose: () => void;
  onCompleted: () => void;
}>;

const METHODS: readonly Readonly<{ value: PaymentMethod; label: string }>[] = Object.freeze([
  Object.freeze({ value: "cash", label: "现金" }),
  Object.freeze({ value: "wechat", label: "微信" }),
  Object.freeze({ value: "alipay", label: "支付宝" }),
  Object.freeze({ value: "other", label: "其他" }),
]);

function allGarmentsTerminal(order: OrderGetResult): boolean {
  return order.garments.every(
    (garment) =>
      garment.status === "picked_up" || garment.status === "delivered" || garment.status === "lost",
  );
}

export function paymentCommandFor(order: OrderGetResult): "payment.collect" | "payment.repay" {
  return allGarmentsTerminal(order) ? "payment.repay" : "payment.collect";
}

export function PaymentCollectionDialog({
  open,
  order,
  commandClient,
  queryClient,
  memberEnabled = false,
  onClose,
  onCompleted,
}: PaymentCollectionDialogProps) {
  const toast = useToast();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<string>("cash");
  const [memberAccountId, setMemberAccountId] = useState<string | null>(null);
  const [memberBalanceCents, setMemberBalanceCents] = useState(0);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const command = useMemo(() => paymentCommandFor(order), [order]);
  const isRepayment = command === "payment.repay";

  useEffect(() => {
    if (!open) return;
    setAmount(String(order.balance_cents));
    setMethod("cash");
    setNote("");
    setMemberAccountId(null);
    setMemberBalanceCents(0);
    const customerId = order.customer_id;
    if (!memberEnabled || queryClient === undefined || customerId === null) return;
    let cancelled = false;
    void (async () => {
      const res = await queryClient.execute<unknown>("member.account.get", {
        customer_id: customerId,
      });
      if (cancelled || !res.ok) return;
      const view = parseMemberAccountView(unwrapQueryResult(res.data), customerId);
      // Only an active account with money in it earns the extra option; showing
      // a zero balance choice would just produce a guaranteed rejection.
      if (view?.account == null || view.account.status !== "active") return;
      if (view.account.balance_cents <= 0) return;
      setMemberAccountId(view.account.account_id);
      setMemberBalanceCents(view.account.balance_cents);
    })();
    return () => {
      cancelled = true;
    };
  }, [memberEnabled, open, order.balance_cents, order.customer_id, order.order_id, queryClient]);

  const submit = async () => {
    const plan = buildPaymentSubmission({
      ledgerCommand: command,
      orderId: order.order_id,
      orderBalanceCents: order.balance_cents,
      amountCents: parseNonNegCents(amount),
      method,
      note,
      memberAccountId,
      memberBalanceCents,
    });
    if (!plan.ok) {
      toast.push(submissionErrorMessage(plan.reason), "error");
      return;
    }
    setBusy(true);
    try {
      const res = await commandClient.execute<unknown>(plan.command, plan.body);
      if (!res.ok) {
        toast.push(res.error.message ?? res.error.code, "error");
        return;
      }
      toast.push(
        plan.usesBalance
          ? "已从会员余额扣款并记入支付流水"
          : isRepayment
            ? "补缴已记入支付流水"
            : "收款已记入支付流水",
        "success",
      );
      onCompleted();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      title={isRepayment ? "补缴欠款" : "独立收款"}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <>
          <Button variant="ghost" type="button" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" type="button" onClick={() => void submit()} disabled={busy}>
            {busy ? "提交中…" : isRepayment ? "确认补缴" : "确认收款"}
          </Button>
        </>
      }
    >
      <div className="ld-payment-collection" data-testid="payment-collection-dialog">
        <p>
          当前欠款 <MoneyText fen={order.balance_cents} />
          ；本次将追加一条不可修改的支付流水。
        </p>
        <Input
          name="payment-amount-cents"
          label="本次收款（分）"
          inputMode="numeric"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          disabled={busy}
        />
        <label className="ld-counter-select">
          <span>付款方式</span>
          <select
            value={method}
            onChange={(event) => setMethod(event.target.value)}
            disabled={busy}
          >
            {METHODS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
            {memberAccountId === null ? null : <option value={BALANCE_CHOICE}>会员余额</option>}
          </select>
        </label>
        {method === BALANCE_CHOICE ? (
          <p className="ld-payment-collection__balance">
            会员可用余额 <MoneyText fen={memberBalanceCents} />
            ；扣款与本单支付在同一事务内完成。
          </p>
        ) : null}
        <Input
          name="payment-note"
          label="备注（可选）"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          disabled={busy}
        />
      </div>
    </Dialog>
  );
}
