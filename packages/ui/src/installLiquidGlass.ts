/**
 * Pointer specular + press ripple — migrated from v1 liquidGlass.ts.
 * Pair with tokens.css (.lg-spec / .lg-pressable / .lg-ripple).
 */
export function installLiquidGlass(root: Document = document): () => void {
  const reduce = root.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const onMove = (e: PointerEvent): void => {
    const el = (e.target as HTMLElement | null)?.closest?.(".lg-spec") as HTMLElement | null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  };

  const onDown = (e: PointerEvent): void => {
    if (reduce) return;
    const host = (e.target as HTMLElement | null)?.closest?.(".lg-pressable") as HTMLElement | null;
    if (!host) return;
    const r = host.getBoundingClientRect();
    const d = Math.max(r.width, r.height) * 2.2;
    const s = root.createElement("span");
    s.className = "lg-ripple";
    s.style.width = s.style.height = `${d}px`;
    s.style.left = `${e.clientX - r.left - d / 2}px`;
    s.style.top = `${e.clientY - r.top - d / 2}px`;
    host.appendChild(s);
    s.addEventListener("animationend", () => s.remove());
  };

  root.addEventListener("pointermove", onMove, { passive: true });
  root.addEventListener("pointerdown", onDown);
  return () => {
    root.removeEventListener("pointermove", onMove);
    root.removeEventListener("pointerdown", onDown);
  };
}
