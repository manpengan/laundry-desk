import { Button, Input } from "@laundry/ui";

export function PickupVerificationPanel({
  barcode,
  verified,
  required,
  disabled,
  onBarcodeChange,
  onVerify,
}: Readonly<{
  barcode: string;
  verified: number;
  required: number;
  disabled: boolean;
  onBarcodeChange: (value: string) => void;
  onVerify: () => void;
}>) {
  if (required === 0) return null;
  return (
    <form
      className="ld-pickup-verification"
      aria-label="取衣扫码复核"
      onSubmit={(event) => {
        event.preventDefault();
        onVerify();
      }}
    >
      <Input
        name="pickup-verification-barcode"
        label="复核衣物条码"
        value={barcode}
        onChange={(event) => onBarcodeChange(event.target.value)}
        hint={`已复核 ${verified} / ${required} 件待取衣物`}
        disabled={disabled}
      />
      <Button type="submit" variant="secondary" disabled={disabled}>
        确认扫码
      </Button>
    </form>
  );
}
