import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn.js";
import { formatMoneyFromFen, YUAN_SIGN_UI } from "../lib/money.js";

export type MoneyTextSize = "sm" | "md" | "lg" | "xl";

export type MoneyTextProps = {
  /** Integer fen only — never pass float yuan. */
  fen: number;
  size?: MoneyTextSize;
  /** Override currency sign (default UI ¥). Print path should not use this component. */
  sign?: string;
} & Omit<HTMLAttributes<HTMLSpanElement>, "children">;

/**
 * Global-only money renderer for web UI (分 → 元).
 * Do not hand-format amounts elsewhere in apps/web or packages/ui consumers.
 */
export function MoneyText({
  fen,
  size = "md",
  sign = YUAN_SIGN_UI,
  className,
  ...rest
}: MoneyTextProps) {
  const text = formatMoneyFromFen(fen, sign);
  const negative = fen < 0;
  return (
    <span
      className={cn("ld-money", `ld-money--${size}`, negative && "ld-money--negative", className)}
      data-fen={fen}
      {...rest}
    >
      {text}
    </span>
  );
}
