import { useEffect, useRef, useState } from "react";

import { formatFenToYuan, parseYuanToFen } from "../lib/money.js";
import { Input, type InputProps } from "./Input.js";

export type MoneyInputProps = Omit<InputProps, "value" | "onChange" | "type"> & {
  /** Amount in integer fen, as text. Empty string means "not entered yet". */
  valueFen: string;
  /** Receives integer fen as text, or "" while the typed amount is unusable. */
  onChangeFen: (fen: string) => void;
};

/** Yuan text for a fen amount, or "" when fen is absent or not an integer. */
function toYuanText(fen: string): string {
  const trimmed = fen.trim();
  if (!/^-?\d+$/u.test(trimmed)) return "";
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? formatFenToYuan(parsed) : "";
}

/**
 * Preserve text only when it produced the incoming fen value. Any other prop
 * change is an external load/reset and must replace the displayed amount.
 */
function reconcileMoneyInputText(
  currentText: string,
  valueFen: string,
  lastEmittedFen: string | null,
): string {
  return lastEmittedFen === valueFen ? currentText : toYuanText(valueFen);
}

/**
 * Money field that reads and writes yuan while keeping the integer-fen contract
 * its callers already use. Counter staff enter "15.00", never "1500" — a dropped
 * zero in the fen form is a tenfold collection error.
 *
 * The typed text is local state so partial input ("15.") survives a keystroke;
 * only a fully parsed amount reaches `onChangeFen`.
 */
export function MoneyInput({ valueFen, onChangeFen, hint, onBlur, ...rest }: MoneyInputProps) {
  const [text, setText] = useState(() => toYuanText(valueFen));
  const [touched, setTouched] = useState(false);
  const lastEmittedFen = useRef<string | null>(null);

  // Follow programmatic resets (form cleared, order reloaded) without clobbering
  // partial text that produced the current parent value.
  useEffect(() => {
    const emitted = lastEmittedFen.current;
    setText((current) => reconcileMoneyInputText(current, valueFen, emitted));
    if (emitted !== valueFen) lastEmittedFen.current = null;
  }, [valueFen]);

  const parsed = parseYuanToFen(text);
  const empty = text.trim().length === 0;
  const invalid = touched && !empty && !parsed.ok;
  // exactOptionalPropertyTypes: pass the key only when it carries a value.
  const feedback = invalid
    ? { error: parsed.ok ? "" : parsed.message }
    : { hint: hint ?? "金额以元为单位，最多两位小数" };

  return (
    <Input
      {...rest}
      {...feedback}
      inputMode="decimal"
      value={text}
      onBlur={(event) => {
        setTouched(true);
        onBlur?.(event);
      }}
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        const result = parseYuanToFen(next);
        const nextFen = result.ok ? String(result.fen) : "";
        lastEmittedFen.current = nextFen;
        onChangeFen(nextFen);
      }}
    />
  );
}
