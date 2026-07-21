/**
 * Thermal print amount helpers (from M0-3).
 * Fullwidth ￥ is required for GBK — halfwidth ¥ becomes "?".
 * No job/receipt schema here (waits Codex D4 ports).
 */

export const YUAN_SIGN_GBK = "￥";

export function assertIntegerFen(fen: number): void {
  if (!Number.isInteger(fen)) {
    throw new Error(`amount must be integer fen, got ${String(fen)}`);
  }
}

export function fenToYuanText(fen: number): string {
  assertIntegerFen(fen);
  const sign = fen < 0 ? "-" : "";
  const abs = Math.abs(fen);
  const yuan = Math.floor(abs / 100);
  const rem = abs % 100;
  return `${sign}${yuan}.${rem.toString().padStart(2, "0")}`;
}

/** e.g. ￥60.00 — safe for GBK ESC/POS / TSPL payloads. */
export function fenToYuanGbk(fen: number): string {
  return `${YUAN_SIGN_GBK}${fenToYuanText(fen)}`;
}
