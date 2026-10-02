import { Button, Icon, Input } from "@laundry/ui";

type PickupLookupFormProps = Readonly<{
  value: string;
  busy: boolean;
  loading: boolean;
  queryAvailable: boolean;
  onChange: (value: string) => void;
  onLookup: () => void;
}>;

export function PickupLookupForm(props: PickupLookupFormProps) {
  return (
    <div className="ld-order-form__load-row">
      <Input
        name="pickup-key"
        className="ld-input--scan"
        label="票号 / 取件码 / 条码 / 手机号 / 姓名"
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        hint="同一手机号有多张未取订单时，会列出供你选择"
        disabled={props.busy}
        autoComplete="off"
        spellCheck={false}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            props.onLookup();
          }
        }}
      />
      <div className="ld-order-form__load-action">
        <Button
          variant="secondary"
          size="lg"
          type="button"
          onClick={props.onLookup}
          disabled={props.busy || props.loading || !props.queryAvailable}
        >
          <Icon name="search" size={18} />
          {props.loading ? "加载中…" : "加载订单"}
        </Button>
      </div>
    </div>
  );
}
