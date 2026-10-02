import { cn } from "../lib/cn.js";

export type NumberPadKey = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

const DIGITS: readonly NumberPadKey[] = Object.freeze([
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
]);

/** Pure: apply one keypad press to the current text value. */
export function applyNumberPadKey(
  value: string,
  key: NumberPadKey | "clear" | "backspace",
  maxLength = 32,
): string {
  if (key === "clear") return "";
  if (key === "backspace") return value.slice(0, -1);
  return value.length >= maxLength ? value : `${value}${key}`;
}

export type NumberPadProps = Readonly<{
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  maxLength?: number;
  label?: string;
  className?: string;
}>;

/** UI spec PosNumberPad: large touch keys for pickup codes and amounts. */
export function NumberPad({
  value,
  onChange,
  disabled = false,
  maxLength = 32,
  label = "数字键盘",
  className,
}: NumberPadProps) {
  const press = (key: NumberPadKey | "clear" | "backspace"): void => {
    onChange(applyNumberPadKey(value, key, maxLength));
  };
  return (
    <div className={cn("ld-numpad", className)} role="group" aria-label={label}>
      {DIGITS.map((digit) => (
        <button
          key={digit}
          type="button"
          className="ld-numpad__key"
          onClick={() => press(digit)}
          disabled={disabled}
        >
          {digit}
        </button>
      ))}
      <button
        type="button"
        className="ld-numpad__key ld-numpad__key--action"
        onClick={() => press("clear")}
        disabled={disabled}
      >
        清空
      </button>
      <button
        type="button"
        className="ld-numpad__key"
        onClick={() => press("0")}
        disabled={disabled}
      >
        0
      </button>
      <button
        type="button"
        className="ld-numpad__key ld-numpad__key--action"
        onClick={() => press("backspace")}
        disabled={disabled}
        aria-label="退格"
      >
        ⌫
      </button>
    </div>
  );
}
