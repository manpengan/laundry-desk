import { Button, Input, MoneyText } from "@laundry/ui";

import type { PaymentMethod } from "./order-form.js";
import type { PricingPolicyView } from "./pricing-policy-model.js";
import type { PricingSelection, ReceivePreviewTotals } from "./receive-pricing-selection.js";

const PAYMENT_METHODS: readonly Readonly<{ value: PaymentMethod; label: string }>[] = Object.freeze(
  [
    Object.freeze({ value: "cash", label: "现金" }),
    Object.freeze({ value: "wechat", label: "微信" }),
    Object.freeze({ value: "alipay", label: "支付宝" }),
    Object.freeze({ value: "other", label: "其他" }),
  ],
);

export type ReceiveSettlementPanelProps = Readonly<{
  busy: boolean;
  policyReady: boolean;
  canDiscount: boolean;
  draftId: string | null;
  pricing: PricingSelection;
  policy: PricingPolicyView;
  totals: ReceivePreviewTotals;
  paymentCents: string;
  paymentMethod: PaymentMethod;
  note: string;
  onPricingChange: (pricing: PricingSelection) => void;
  onPaymentCentsChange: (value: string) => void;
  onPaymentMethodChange: (value: PaymentMethod) => void;
  onNoteChange: (value: string) => void;
  onSubmit: () => void;
  onHold: () => void;
  onReset: () => void;
}>;

export function ReceiveSettlementPanel({
  busy,
  policyReady,
  canDiscount,
  draftId,
  pricing,
  policy,
  totals,
  paymentCents,
  paymentMethod,
  note,
  onPricingChange,
  onPaymentCentsChange,
  onPaymentMethodChange,
  onNoteChange,
  onSubmit,
  onHold,
  onReset,
}: ReceiveSettlementPanelProps) {
  return (
    <section className="ld-counter-panel ld-counter-panel--settlement" aria-label="结算">
      <div className="ld-counter-panel__head">
        <h2 className="ld-counter-panel__title">结算</h2>
        {draftId === null ? null : <span className="ld-counter-draft">挂单待确认</span>}
      </div>
      <div className="ld-counter-adjustments">
        {canDiscount ? (
          <Input
            name="discount-cents"
            label="店长折扣（分）"
            inputMode="numeric"
            value={pricing.discount_cents}
            onChange={(event) =>
              onPricingChange(Object.freeze({ ...pricing, discount_cents: event.target.value }))
            }
            disabled={busy || !policyReady}
          />
        ) : null}
        <label className="ld-counter-adjustment-toggle">
          <input
            type="checkbox"
            checked={pricing.urgent}
            onChange={(event) =>
              onPricingChange(Object.freeze({ ...pricing, urgent: event.target.checked }))
            }
            disabled={busy || !policyReady}
          />
          加急（
          <MoneyText fen={policy.urgent_cents} />）
        </label>
        <label className="ld-counter-adjustment-toggle">
          <input
            type="checkbox"
            checked={pricing.freight}
            onChange={(event) =>
              onPricingChange(Object.freeze({ ...pricing, freight: event.target.checked }))
            }
            disabled={busy || !policyReady}
          />
          运费（
          <MoneyText fen={policy.freight_cents} />）
        </label>
      </div>
      <div className="ld-counter-totals" aria-label="本地预览">
        <span>
          原价 <MoneyText fen={totals.original} />
        </span>
        <span>
          折扣 −<MoneyText fen={totals.discount} />
        </span>
        <span>
          附加 +<MoneyText fen={totals.addon + totals.urgent + totals.freight} />
        </span>
        <strong>
          应收预览 <MoneyText fen={totals.payable} />
        </strong>
      </div>
      <Input
        name="initial-payment"
        label="首笔收款（分）"
        inputMode="numeric"
        value={paymentCents}
        onChange={(event) => onPaymentCentsChange(event.target.value)}
        hint="0 表示欠款，不写 payment 流水"
        disabled={busy}
      />
      <label className="ld-counter-select">
        <span>付款方式</span>
        <select
          value={paymentMethod}
          onChange={(event) => onPaymentMethodChange(event.target.value as PaymentMethod)}
          disabled={busy}
        >
          {PAYMENT_METHODS.map((method) => (
            <option key={method.value} value={method.value}>
              {method.label}
            </option>
          ))}
        </select>
      </label>
      <Input
        name="note"
        label="备注（可选）"
        value={note}
        onChange={(event) => onNoteChange(event.target.value)}
        disabled={busy}
      />
      <div className="ld-counter-actions">
        <Button variant="primary" type="button" onClick={onSubmit} disabled={busy || !policyReady}>
          {busy ? "提交中…" : draftId === null ? "确认开单" : "确认挂单并开单"}
        </Button>
        <Button variant="secondary" type="button" onClick={onHold} disabled={busy || !policyReady}>
          暂存挂单
        </Button>
        <Button variant="ghost" type="button" onClick={onReset} disabled={busy}>
          清空
        </Button>
      </div>
      <p className="ld-counter-panel__hint">
        {policyReady
          ? `计价设置版本 ${policy.version}；预览只作输入反馈，最终金额由服务端权威计算。`
          : "计价设置尚未读取成功；为避免错价，开单与挂单已停用。"}
      </p>
    </section>
  );
}
