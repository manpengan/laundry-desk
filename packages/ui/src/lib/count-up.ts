import { useEffect, useRef, useState } from "react";

export function easeOutCubic(t: number): number {
  const rest = 1 - Math.min(Math.max(t, 0), 1);
  return 1 - rest * rest * rest;
}

/** Pure: the integer shown at progress t (0…1) of a roll from `from` to `to`. */
export function countUpValue(from: number, to: number, t: number): number {
  return Math.round(from + (to - from) * easeOutCubic(t));
}

function lively(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.motion === "full";
}

export type CountUpOptions = Readonly<{
  /** Roll up from zero when first shown (dashboards loading their figures). */
  fromZero?: boolean;
  durationMs?: number;
}>;

/**
 * 数字滚动 (ADR 2026-07-18 §2.4): an integer rolls from its previous value to
 * the new one, 850ms easeOutCubic. Only at <html data-motion="full">; server
 * rendering, tests and the calm/off tiers always show the final value.
 */
export function useCountUp(target: number, options: CountUpOptions = {}): number {
  const { fromZero = false, durationMs = 850 } = options;
  const [shown, setShown] = useState(() => (fromZero && lively() ? 0 : target));
  const previous = useRef(shown);

  useEffect(() => {
    const start = previous.current;
    previous.current = target;
    if (start === target || !lively() || typeof requestAnimationFrame === "undefined") {
      setShown(target);
      return undefined;
    }
    let frame = 0;
    const began = performance.now();
    const tick = (now: number): void => {
      const t = (now - began) / durationMs;
      setShown(t >= 1 ? target : countUpValue(start, target, t));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, durationMs]);

  return shown;
}
