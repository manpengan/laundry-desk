import { Button, Icon, Input, MoneyInput, MoneyText } from "@laundry/ui";
import type { ScalePort } from "../host/scale-port.js";
import { ScaleCapturePanel } from "./ScaleCapturePanel.js";
import { appendScaleReading } from "./scale-reading.js";

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
  scalePort?: ScalePort;
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
  phone: string;
  name: string;
  onPhoneChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onPricingChange: (pricing: PricingSelection) => void;
  onPaymentCentsChange: (value: string) => void;
  onPaymentMethodChange: (value: PaymentMethod) => void;
  onNoteChange: (value: string) => void;
  onSubmit: () => void;
  onHold: () => void;
  onReset: () => void;
}>;

export function ReceiveSettlementPanel({
  scalePort,
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
  phone,
  name,
  onPhoneChange,
  onNameChange,
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
      <div className="ld-settlement-fields">
        <div className="ld-counter-panel__head">
          <h2 className="ld-counter-panel__title">
            <Icon name="customers" size={18} />
            客户与结算
          </h2>
          {draftId === null ? null : <span className="ld-counter-draft">挂单待确认</span>}
        </div>
        {scalePort && (
          <ScaleCapturePanel
            port={scalePort}
            disabled={busy}
            onApply={(reading) => {
              const next = appendScaleReading(note, reading);
              if (next === null) return false;
              onNoteChange(next);
              return true;
            }}
          />
        )}
        <div className="ld-receive-customer">
          <Input
            name="customer-phone"
            label="手机号（可选）"
            inputMode="tel"
            autoComplete="off"
            value={phone}
            onChange={(event) => onPhoneChange(event.target.value)}
            disabled={busy}
          />
          <Input
            name="customer-name"
            label="客户姓名（可选）"
            autoComplete="off"
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            disabled={busy}
          />
        </div>
        <div className="ld-receive-payment">
          <MoneyInput
            name="initial-payment"
            label="首笔收款"
            valueFen={paymentCents}
            onChangeFen={onPaymentCentsChange}
            hint="填 0 表示先记欠款，取衣时再收"
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
        </div>
        <div className="ld-counter-adjustments">
          {canDiscount ? (
            <MoneyInput
              name="discount-cents"
              label="店长折扣"
              valueFen={pricing.discount_cents}
              onChangeFen={(fen) =>
                onPricingChange(Object.freeze({ ...pricing, discount_cents: fen }))
              }
              disabled={busy || !policyReady}
            />
          ) : null}
          <div className="ld-counter-adjustment-toggles">
            <label className="ld-counter-adjustment-toggle">
              <input
                type="checkbox"
                checked={pricing.urgent}
                onChange={(event) =>
                  onPricingChange(Object.freeze({ ...pricing, urgent: event.target.checked }))
                }
                disabled={busy || !policyReady}
              />
              <span>
                加急（
                <MoneyText fen={policy.urgent_cents} />）
              </span>
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
              <span>
                运费（
                <MoneyText fen={policy.freight_cents} />）
              </span>
            </label>
          </div>
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
          <strong className="ld-counter-totals__payable">
            应收预览 <MoneyText fen={totals.payable} size="xl" />
          </strong>
        </div>
        <Input
          name="note"
          label="备注（可选）"
          value={note}
          onChange={(event) => onNoteChange(event.target.value)}
          disabled={busy}
        />
        <p className="ld-counter-panel__hint">
          {policyReady
            ? `金额以确认开单时的价目与计价设置为准（版本 ${policy.version}），系统复核计价后出票。`
            : "计价设置尚未读取成功；为避免错价，开单与挂单已停用。"}
        </p>
      </div>
      <div className="ld-counter-actions">
        <div className="ld-counter-actions__row">
          <span className="ld-counter-actions__total">
            应收
            <MoneyText fen={totals.payable} size="lg" />
          </span>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            onClick={onHold}
            disabled={busy || !policyReady}
          >
            暂存挂单
          </Button>
          <Button variant="ghost" size="sm" type="button" onClick={onReset} disabled={busy}>
            清空
          </Button>
        </div>
        <Button
          variant="primary"
          size="lg"
          type="button"
          onClick={onSubmit}
          disabled={busy || !policyReady}
          aria-keyshortcuts="Control+Enter"
        >
          {busy ? "提交中…" : draftId === null ? "确认开单" : "确认挂单并开单"}
          <span className="ld-btn__kbd" aria-hidden="true">
            Ctrl+Enter
          </span>
        </Button>
      </div>
    </section>
  );
}
