import { Button, MoneyInput } from "@laundry/ui";

/** Payment draft controls belong only to the current, selected pickup. */
export function PickupActions(
  props: Readonly<{
    collectText: string;
    onCollectChange: (value: string) => void;
    busy: boolean;
    disabled: boolean;
    canCollect: boolean;
    verificationComplete: boolean;
    canPaySeparately: boolean;
    onSubmit: () => void;
    onPayment: () => void;
    onReset: () => void;
  }>,
) {
  return (
    <div className="ld-order-form__actions">
      <MoneyInput
        name="collect-cents"
        label="本次收款（填 0 不收）"
        valueFen={props.collectText}
        onChangeFen={props.onCollectChange}
        disabled={props.disabled || !props.canCollect}
      />
      <Button
        variant="primary"
        size="lg"
        type="button"
        onClick={props.onSubmit}
        disabled={props.disabled || !props.canCollect || !props.verificationComplete}
      >
        {props.busy ? "提交中…" : "确认取衣"}
      </Button>
      {props.canPaySeparately ? (
        <Button
          variant="secondary"
          type="button"
          onClick={props.onPayment}
          disabled={props.disabled}
        >
          独立收款 / 补缴
        </Button>
      ) : null}
      <Button variant="ghost" type="button" onClick={props.onReset} disabled={props.disabled}>
        清空
      </Button>
    </div>
  );
}
