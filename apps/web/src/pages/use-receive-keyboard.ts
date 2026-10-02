import { useEffect, useRef, type RefObject } from "react";

export type ReceiveKeyboardOptions = Readonly<{
  canSubmit: boolean;
  onSubmit: () => void;
}>;

type KeyProbe = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "isComposing">;

/** Pure: Ctrl/⌘+Enter confirms the order (never during IME composition). */
export function isSubmitChord(event: KeyProbe): boolean {
  return (
    !event.isComposing && event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.altKey
  );
}

/** Pure: plain Enter in a customer field moves on to the catalog search. */
export function isAdvanceFromCustomer(event: KeyProbe, fieldName: string | null): boolean {
  if (event.isComposing || event.key !== "Enter") return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return fieldName === "customer-phone" || fieldName === "customer-name";
}

/** 开单 keyboard flow (UI spec §4.2): 手机号 Enter → 价目搜索；Ctrl+Enter 结算. */
export function useReceiveKeyboard(
  rootRef: RefObject<HTMLElement | null>,
  options: ReceiveKeyboardOptions,
): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const doc = root.ownerDocument;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (doc.querySelector('[aria-modal="true"]') !== null) return;
      if (isSubmitChord(event)) {
        event.preventDefault();
        if (optionsRef.current.canSubmit) optionsRef.current.onSubmit();
        return;
      }
      const target = event.target instanceof HTMLInputElement ? event.target : null;
      if (target !== null && root.contains(target) && isAdvanceFromCustomer(event, target.name)) {
        event.preventDefault();
        root.querySelector<HTMLInputElement>('input[name="catalog-search"]')?.focus();
      }
    };
    doc.addEventListener("keydown", onKeyDown);
    return () => doc.removeEventListener("keydown", onKeyDown);
  }, [rootRef]);
}
