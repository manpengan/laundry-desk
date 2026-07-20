/**
 * Integer fen → display string for UI.
 * Web may use halfwidth ¥ (U+00A5); thermal print GBK must use ￥ (U+FFE5).
 */

export const YUAN_SIGN_UI = "¥";

export function assertIntegerFen(fen: number): void {
  if (!Number.isInteger(fen)) {
    throw new Error(`amount must be integer fen, got ${String(fen)}`);
  }
}

/** "60.00" without currency sign */
export function formatFenToYuan(fen: number): string {
  assertIntegerFen(fen);
  const sign = fen < 0 ? "-" : "";
  const abs = Math.abs(fen);
  const yuan = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${sign}${yuan}.${rem.toString().padStart(2, "0")}`;
}

/** "¥60.00" / "-¥1.50" — sole allowed money text format in UI */
export function formatMoneyFromFen(fen: number, sign = YUAN_SIGN_UI): string {
  assertIntegerFen(fen);
  if (fen < 0) {
    return `-${sign}${formatFenToYuan(Math.abs(fen))}`;
  }
  return `${sign}${formatFenToYuan(fen)}`;
}
