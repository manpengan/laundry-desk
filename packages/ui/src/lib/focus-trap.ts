import { useEffect, useRef, type RefObject } from "react";

/** Elements a keyboard user can reach inside an overlay. */
export const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  'details > summary:first-of-type:not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/** Pure: next index for Tab / Shift+Tab, wrapping inside the overlay. */
export function wrapFocusIndex(current: number, total: number, backwards: boolean): number {
  if (total <= 0) return -1;
  if (current < 0) return backwards ? total - 1 : 0;
  if (backwards) return current === 0 ? total - 1 : current - 1;
  return current === total - 1 ? 0 : current + 1;
}

type FocusCandidate = Readonly<{ autofocus: boolean; dismiss: boolean }>;

/**
 * Pure: initial focus target. An explicit [data-autofocus] wins; otherwise the
 * first real field/action, skipping the header close button so Enter never
 * dismisses a confirmation by accident.
 */
export function pickInitialFocus(candidates: readonly FocusCandidate[]): number {
  const explicit = candidates.findIndex((candidate) => candidate.autofocus);
  if (explicit >= 0) return explicit;
  const firstAction = candidates.findIndex((candidate) => !candidate.dismiss);
  if (firstAction >= 0) return firstAction;
  return candidates.length > 0 ? 0 : -1;
}

function hiddenByClosedDetails(element: HTMLElement): boolean {
  for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
    if (!parent.matches("details:not([open])")) continue;
    const summary = Array.from(parent.children).find((child) => child.tagName === "SUMMARY");
    if (summary === undefined || !summary.contains(element)) return true;
  }
  return false;
}

function focusables(container: HTMLElement): HTMLElement[] {
  const active = container.ownerDocument.activeElement;
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) =>
      !hiddenByClosedDetails(element) &&
      (element.getClientRects().length > 0 || element === active),
  );
}

function currentActiveElement(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

/**
 * Modal focus contract: move focus in on open, keep Tab inside, and return it to
 * the opener on close (WCAG 2.4.3). Escape handling stays with the component.
 */
export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, open: boolean): void {
  // Record the opener while rendering the closed→open transition, before any
  // child autoFocus can move document focus into the overlay.
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  if (open && !wasOpenRef.current) openerRef.current = currentActiveElement();
  wasOpenRef.current = open;

  useEffect(() => {
    if (!open) return;
    const container = containerRef.current;
    if (container === null) return;
    const doc = container.ownerDocument;
    const opener = openerRef.current;

    const active = doc.activeElement;
    const claimed = active !== null && active !== container && container.contains(active);
    if (!claimed) {
      const items = focusables(container);
      const initial = pickInitialFocus(
        items.map((element) =>
          Object.freeze({
            autofocus: element.hasAttribute("data-autofocus"),
            dismiss: element.hasAttribute("data-overlay-dismiss"),
          }),
        ),
      );
      (initial >= 0 ? items[initial] : container)?.focus({ preventScroll: true });
    }

    // Only the topmost overlay (last aria-modal in document order) traps.
    const isTopmost = (): boolean => {
      const modals = doc.querySelectorAll('[aria-modal="true"]');
      const last = modals[modals.length - 1];
      return last === undefined || last === container || last.contains(container);
    };

    // Listening on the document (not the overlay) keeps Tab trapped even after
    // a control that disabled itself mid-request ("刷新中…") dropped focus to
    // <body>, where overlay-level listeners no longer hear the key.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Tab" || !isTopmost()) return;
      const current = focusables(container);
      if (current.length === 0) {
        event.preventDefault();
        container.focus({ preventScroll: true });
        return;
      }
      const index = current.findIndex((element) => element === doc.activeElement);
      const leaving =
        index < 0 ||
        (event.shiftKey && index === 0) ||
        (!event.shiftKey && index === current.length - 1);
      if (leaving) {
        event.preventDefault();
        current[wrapFocusIndex(index, current.length, event.shiftKey)]?.focus();
      }
    };

    // A focused control that becomes disabled (or is removed) leaves focus on
    // <body>; pull it back to the overlay so the next key still lands inside.
    const onFocusOut = (event: FocusEvent): void => {
      if (event.relatedTarget !== null) return;
      queueMicrotask(() => {
        const now = doc.activeElement;
        if (!container.isConnected || (now !== null && now !== doc.body)) return;
        if (isTopmost()) container.focus({ preventScroll: true });
      });
    };

    doc.addEventListener("keydown", onKeyDown, true);
    container.addEventListener("focusout", onFocusOut);
    return () => {
      doc.removeEventListener("keydown", onKeyDown, true);
      container.removeEventListener("focusout", onFocusOut);
      if (opener !== null && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, [containerRef, open]);
}
