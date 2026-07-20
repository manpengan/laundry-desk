/** Amounts are integer fen only. Never use float. */

/**
 * Fullwidth yen ￥ (U+FFE5) → GBK 0xA3 0xA4.
 * Halfwidth ¥ (U+00A5) is NOT in GBK; iconv falls back to 0x3F "?".
 * Always use this for ESC/POS / TSPL Chinese thermal printers.
 */
export const YUAN_SIGN = "￥";

export function fenToYuanText(fen: number): string {
  if (!Number.isInteger(fen)) {
    throw new Error(`amount must be integer fen, got ${fen}`);
  }
  const sign = fen < 0 ? "-" : "";
  const abs = Math.abs(fen);
  const yuan = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${sign}${yuan}.${rem.toString().padStart(2, "0")}`;
}

/** e.g. ￥60.00 — safe for GBK payload. */
export function fenToYuanWithSign(fen: number): string {
  return `${YUAN_SIGN}${fenToYuanText(fen)}`;
}

export function sumFen(values: readonly number[]): number {
  return values.reduce((acc, v) => {
    if (!Number.isInteger(v)) {
      throw new Error(`amount must be integer fen, got ${v}`);
    }
    return acc + v;
  }, 0);
}
