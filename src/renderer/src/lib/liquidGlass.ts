export function installLiquidGlass(): void {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.addEventListener("pointermove", (e) => {
    const el = (e.target as HTMLElement)?.closest?.(".lg-spec") as HTMLElement | null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  }, { passive: true });
  if (reduce) return;
  document.addEventListener("pointerdown", (e) => {
    const host = (e.target as HTMLElement)?.closest?.(".lg-pressable") as HTMLElement | null;
    if (!host) return;
    const r = host.getBoundingClientRect();
    const d = Math.max(r.width, r.height) * 2.2;
    const s = document.createElement("span");
    s.className = "lg-ripple";
    s.style.width = s.style.height = `${d}px`;
    s.style.left = `${e.clientX - r.left - d / 2}px`;
    s.style.top = `${e.clientY - r.top - d / 2}px`;
    host.appendChild(s);
    s.addEventListener("animationend", () => s.remove());
  });
}
