import { useState } from "react";
import { cn } from "../lib/cn.js";
import { Icon } from "./Icon.js";

/**
 * Pure: counter-safe display of a phone number. Mainland 11-digit numbers keep
 * 3 + 4 digits (139****4629); other lengths keep at most the last 4.
 */
export function maskPhone(phone: string): string {
  const trimmed = phone.trim();
  if (trimmed.length === 0) return trimmed;
  if (trimmed.includes("*")) return trimmed;
  const digits = trimmed.replace(/\D/gu, "");
  if (digits.length === 11) return `${digits.slice(0, 3)}****${digits.slice(7)}`;
  if (digits.length <= 4) return "*".repeat(digits.length);
  return `${"*".repeat(Math.min(digits.length - 4, 6))}${digits.slice(-4)}`;
}

export type MaskedPhoneProps = Readonly<{
  phone: string;
  className?: string;
}>;

/** Shows a masked number with an explicit, local-only reveal toggle. */
export function MaskedPhone({ phone, className }: MaskedPhoneProps) {
  const [revealed, setRevealed] = useState(false);
  const masked = maskPhone(phone);
  const canReveal = masked !== phone.trim();
  return (
    <span className={cn("ld-masked", className)}>
      <span>{revealed ? phone : masked}</span>
      {canReveal ? (
        <button
          type="button"
          className="ld-masked__toggle"
          onClick={(event) => {
            event.stopPropagation();
            setRevealed((value) => !value);
          }}
          aria-label={revealed ? "隐藏完整号码" : "显示完整号码"}
          aria-pressed={revealed}
          title={revealed ? "隐藏完整号码" : "显示完整号码"}
        >
          <Icon name={revealed ? "eyeOff" : "eye"} size={16} />
        </button>
      ) : null}
    </span>
  );
}
