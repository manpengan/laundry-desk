import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../lib/cn.js";
import { useMagneticIndicator } from "../lib/magnetic-indicator.js";

export type TabItem<T extends string> = Readonly<{
  id: T;
  label: ReactNode;
  /** Keyboard hint rendered after the label (e.g. "F1"). */
  hint?: string;
  disabled?: boolean;
}>;

export type TabsProps<T extends string> = Readonly<{
  items: readonly TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  /**
   * "nav": toggle buttons (aria-pressed) that switch views — keeps button
   * semantics for existing automation. "radio": a single choice (aria-checked)
   * with arrow-key movement, for settings such as theme.
   */
  mode?: "nav" | "radio";
  className?: string;
}>;

/** Pure: arrow-key target inside a radio group, skipping disabled items. */
export function nextEnabledIndex(
  disabled: readonly boolean[],
  current: number,
  step: 1 | -1,
): number {
  const total = disabled.length;
  if (total === 0) return -1;
  for (let offset = 1; offset <= total; offset += 1) {
    const index = (current + step * offset + total * offset) % total;
    if (disabled[index] !== true) return index;
  }
  return current;
}

const SELECTED_TAB = '.ld-tabs__tab[aria-pressed="true"], .ld-tabs__tab[aria-checked="true"]';

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  label,
  mode = "nav",
  className,
}: TabsProps<T>) {
  const radio = mode === "radio";
  const groupRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);
  // 磁性焦点: one glass thumb glides to the selected tab (decorative only).
  const thumbReady = useMagneticIndicator(groupRef, thumbRef, SELECTED_TAB, String(value));

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!radio) return;
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const current = items.findIndex((item) => item.id === value);
    const next = nextEnabledIndex(
      items.map((item) => item.disabled === true),
      current,
      step,
    );
    const target = items[next];
    if (target !== undefined) onChange(target.id);
  };

  return (
    <div
      ref={groupRef}
      className={cn("ld-tabs", className)}
      role={radio ? "radiogroup" : "group"}
      aria-label={label}
      onKeyDown={onKeyDown}
      data-thumb={thumbReady ? "ready" : undefined}
    >
      <span ref={thumbRef} className="ld-tabs__thumb" aria-hidden="true">
        <span />
      </span>
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            className="ld-tabs__tab"
            disabled={item.disabled}
            onClick={() => onChange(item.id)}
            {...(radio
              ? { role: "radio", "aria-checked": selected, tabIndex: selected ? 0 : -1 }
              : { "aria-pressed": selected })}
          >
            {item.label}
            {item.hint === undefined ? null : <span className="ld-tabs__hint">{item.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}
