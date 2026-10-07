/**
 * Pointer specular + press ripple — migrated from v1 liquidGlass.ts.
 * Pair with glass.css (.lg-spec / .lg-pressable / .lg-ripple).
 *
 * CSP-safe under the desktop app:// policy: positions go through CSSOM
 * (style.setProperty / style.width), never a style attribute or <style> text.
 * Both effects run only while <html data-motion="full">, so the calm and off
 * tiers (software rendering, reduced motion) cost nothing per pointer event.
 */
export function installLiquidGlass(root: Document = document): () => void {
  const view = root.defaultView;
  const lively = (): boolean => root.documentElement.dataset.motion === "full";
  let pending: PointerEvent | null = null;
  let frame = 0;

  const flushSpecular = (): void => {
    frame = 0;
    const event = pending;
    pending = null;
    const el = (event?.target as Element | null)?.closest?.(".lg-spec") as HTMLElement | null;
    if (event === null || !el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${event.clientX - r.left}px`);
    el.style.setProperty("--my", `${event.clientY - r.top}px`);
  };

  // At most one layout read per frame, however fast the pointer reports.
  const onMove = (e: PointerEvent): void => {
    if (!lively()) return;
    pending = e;
    if (frame === 0 && view !== null) frame = view.requestAnimationFrame(flushSpecular);
  };

  const onDown = (e: PointerEvent): void => {
    if (!lively()) return;
    const host = (e.target as Element | null)?.closest?.(".lg-pressable") as HTMLElement | null;
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
  root.addEventListener("pointerdown", onDown, { passive: true });
  return () => {
    root.removeEventListener("pointermove", onMove);
    root.removeEventListener("pointerdown", onDown);
    if (frame !== 0) view?.cancelAnimationFrame(frame);
  };
}
