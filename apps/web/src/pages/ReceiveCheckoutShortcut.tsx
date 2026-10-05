import type { RefObject } from "react";
import { Button, MoneyText } from "@laundry/ui";

export function ReceiveCheckoutShortcut({
  total,
  pageRef,
}: Readonly<{
  total: number;
  pageRef: RefObject<HTMLElement | null>;
}>) {
  return (
    <div className="ld-receive-checkout-shortcut">
      <MoneyText fen={total} />
      <Button
        type="button"
        variant="secondary"
        onClick={() => {
          const field = pageRef.current?.querySelector<HTMLInputElement>(
            'input[name="customer-phone"]',
          );
          field?.scrollIntoView({ block: "center" });
          field?.focus({ preventScroll: true });
        }}
      >
        去客户与结算
      </Button>
    </div>
  );
}
