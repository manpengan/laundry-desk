import { useEffect, type RefObject } from "react";
import type { OrderGetResult } from "./order-form.js";
import type { PickupResultView } from "./PickupDetails.js";
import { mayHandOffFocus, useScanFocus } from "./use-scan-focus.js";

const SCAN_FIELDS = Object.freeze(["pickup-key", "pickup-verification-barcode"]);

/** Hand off the scanner after lookup/pickup, without stealing the money field's caret. */
export function usePickupScanFocus(
  pageRef: RefObject<HTMLElement | null>,
  disabled: boolean,
  loaded: OrderGetResult | null,
  result: PickupResultView | null,
) {
  useScanFocus(pageRef, 'input[name="pickup-key"]');
  useEffect(() => {
    const root = pageRef.current;
    if (root === null || disabled || (loaded === null && result === null)) return;
    const doc = root.ownerDocument;
    if (doc.querySelector('[aria-modal="true"]') !== null) return;
    if (!mayHandOffFocus(doc.activeElement, SCAN_FIELDS)) return;
    const next =
      root.querySelector<HTMLInputElement>('input[name="pickup-verification-barcode"]') ??
      root.querySelector<HTMLInputElement>('input[name="pickup-key"]');
    next?.focus({ preventScroll: true });
    if (next?.name === "pickup-key") next.select();
  }, [disabled, loaded, pageRef, result]);
}
