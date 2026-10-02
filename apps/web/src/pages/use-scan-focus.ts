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

/**
 * Scanner-first pages (工作台、取衣、开单、客户): put the caret in the primary
 * lookup field as soon as the page opens, so a barcode scan is never lost.
 */
export function useScanFocus(rootRef: RefObject<HTMLElement | null>, selector: string): void {
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const doc = root.ownerDocument;
    const modalOpen = doc.querySelector('[aria-modal="true"]') !== null;
    if (!shouldClaimFocus(doc.activeElement, root, modalOpen)) return;
    root.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
  }, [rootRef, selector]);
}
