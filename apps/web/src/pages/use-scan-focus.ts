import { useEffect, type RefObject } from "react";

type FocusProbe = Readonly<{
  closest?: (selectors: string) => unknown;
}>;

type RootProbe = Readonly<{
  ownerDocument: Readonly<{ body: unknown; documentElement: unknown }>;
}>;

/**
 * Pure: may the opening page take focus for its scan field? Yes when nothing is
 * focused or focus is still on the navigation that opened the page; never while
 * the clerk types elsewhere, works a top-bar control, or a modal is open.
 */
export function shouldClaimFocus(
  active: FocusProbe | null,
  root: RootProbe,
  modalOpen: boolean,
): boolean {
  if (modalOpen) return false;
  if (active === null) return true;
  if (active === root.ownerDocument.body || active === root.ownerDocument.documentElement) {
    return true;
  }
  // Only the controls that *open* a page hand focus over: the rail, the
  // command trigger and the skip link. Other top-bar controls (AI, print
  // queue, staff switch) keep the clerk's focus even while a page lazy-loads.
  const fromNavigation = active.closest?.(".ld-shell-sidebar, .ld-shell-command, .ld-skip-link");
  return fromNavigation !== undefined && fromNavigation !== null;
}

type FieldProbe = Readonly<{
  matches?: (selectors: string) => boolean;
  getAttribute?: (name: string) => string | null;
}>;

const TYPING_FIELDS =
  'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), textarea, select, [contenteditable="true"]';

/**
 * Pure: may an async step (an order finished loading) move the caret to `target`?
 * Never while the clerk is typing in another field (e.g. 本次收款); the scan
 * fields named in `scanFields` may always hand over to the next step.
 */
export function mayHandOffFocus(active: FieldProbe | null, scanFields: readonly string[]): boolean {
  if (active === null || active.matches?.(TYPING_FIELDS) !== true) return true;
  const name = active.getAttribute?.("name") ?? null;
  return name !== null && scanFields.includes(name);
}

/**
 * Scanner-first pages (工作台、取衣、开单、客户): put the caret in the primary
 * lookup field as soon as the page opens, so a barcode scan is never lost.
 */
export function useScanFocus(
  rootRef: RefObject<HTMLElement | null>,
  selector: string,
  enabled = true,
): void {
  useEffect(() => {
    const root = rootRef.current;
    if (root === null || !enabled) return;
    const doc = root.ownerDocument;
    const modalOpen = doc.querySelector('[aria-modal="true"]') !== null;
    if (!shouldClaimFocus(doc.activeElement, root, modalOpen)) return;
    root.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
  }, [rootRef, selector, enabled]);
}
