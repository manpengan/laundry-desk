/** Independent counter collection / repayment against the append-only payment ledger. */

import { Button, Dialog, Input, MoneyText, useToast } from "@laundry/ui";
import { useEffect, useMemo, useState } from "react";

import type { CommandPort } from "../commands/types.js";
import { parseNonNegCents, type OrderGetResult, type PaymentMethod } from "./order-form.js";

export type PaymentCollectionDialogProps = Readonly<{
  open: boolean;
  order: OrderGetResult;
  commandClient: CommandPort;
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
  onClose,
  onCompleted,
}: PaymentCollectionDialogProps) {
  const toast = useToast();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const command = useMemo(() => paymentCommandFor(order), [order]);
  const isRepayment = command === "payment.repay";

  useEffect(() => {
    if (!open) return;
    setAmount(String(order.balance_cents));
    setMethod("cash");
    setNote("");
  }, [open, order.balance_cents, order.order_id]);

  const submit = async () => {
    const amountCents = parseNonNegCents(amount);
    if (amountCents === null || amountCents === 0) {
      toast.push("收款金额须为正整数分", "error");
      return;
    }
    if (amountCents > order.balance_cents) {
      toast.push("收款不能超过当前欠款", "error");
      return;
    }
    const trimmedNote = note.trim();
    if (trimmedNote.length > 256) {
      toast.push("备注不能超过 256 个字符", "error");
      return;
    }
    setBusy(true);
    try {
      const res = await commandClient.execute<unknown>(command, {
        order_id: order.order_id,
        amount_cents: amountCents,
        method,
        ...(trimmedNote.length === 0 ? {} : { note: trimmedNote }),
      });
      if (!res.ok) {
        toast.push(res.error.message ?? res.error.code, "error");
        return;
      }
      toast.push(isRepayment ? "补缴已记入支付流水" : "收款已记入支付流水", "success");
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
            onChange={(event) => setMethod(event.target.value as PaymentMethod)}
            disabled={busy}
          >
            {METHODS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
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
