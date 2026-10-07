import { useLayoutEffect, useRef, useState, type RefObject } from "react";

/** Offset box of an item inside the indicator's positioned container. */
export type IndicatorBox = Readonly<{ x: number; y: number; w: number; h: number }>;

export function sameBox(a: IndicatorBox | null, b: IndicatorBox): boolean {
  return a !== null && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** Pure: FLIP start transform that makes a box of size `next` look like `prev`. */
export function flipStartTransform(prev: IndicatorBox, next: IndicatorBox): string {
  const sx = next.w > 0 ? prev.w / next.w : 1;
  const sy = next.h > 0 ? prev.h / next.h : 1;
  return `translate3d(${prev.x}px, ${prev.y}px, 0) scale(${sx}, ${sy})`;
}

export function restingTransform(box: IndicatorBox): string {
  return `translate3d(${box.x}px, ${box.y}px, 0)`;
}

function measure(target: HTMLElement): IndicatorBox {
  return {
    x: target.offsetLeft,
    y: target.offsetTop,
    w: target.offsetWidth,
    h: target.offsetHeight,
  };
}

/**
 * Moves the indicator to `next`. With a previous box it glides: the size is set
 * at once and the FLIP start transform is committed before the CSS transition
 * takes it to rest, so only transform ever animates (ADR 2026-07-18 §2.7).
 * data-glide flips between "a" and "b" to restart the liquid squish keyframes.
 */
function moveIndicator(indicator: HTMLElement, prev: IndicatorBox | null, next: IndicatorBox) {
  indicator.style.width = `${next.w}px`;
  indicator.style.height = `${next.h}px`;
  indicator.style.transition = "none";
  indicator.style.transform =
    prev === null ? restingTransform(next) : flipStartTransform(prev, next);
  void indicator.offsetWidth;
  indicator.style.transition = "";
  if (prev === null) return;
  indicator.style.transform = restingTransform(next);
  indicator.dataset.glide = indicator.dataset.glide === "a" ? "b" : "a";
}

/**
 * 磁性焦点: one decorative indicator (aria-hidden) follows the item matching
 * `activeSelector` inside `container`, which must be its offsetParent
 * (position: relative). Resizes re-place it without animation. Returns whether
 * it is placed, so CSS can keep the item's own active style until then.
 */
export function useMagneticIndicator(
  containerRef: RefObject<HTMLElement | null>,
  indicatorRef: RefObject<HTMLElement | null>,
  activeSelector: string,
  activeKey: string,
): boolean {
  const [placed, setPlaced] = useState(false);
  const last = useRef<IndicatorBox | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const indicator = indicatorRef.current;
    if (!container || !indicator) return undefined;
    const place = (animate: boolean): void => {
      const target = container.querySelector<HTMLElement>(activeSelector);
      if (target === null || target.offsetParent !== container) {
        last.current = null;
        setPlaced(false);
        return;
      }
      const next = measure(target);
      if (!sameBox(last.current, next))
        moveIndicator(indicator, animate ? last.current : null, next);
      last.current = next;
      setPlaced(true);
    };
    place(true);
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => place(false));
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef, indicatorRef, activeSelector, activeKey]);

  return placed;
}
