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

/** Largest amount we accept, in fen. Keeps integer arithmetic exact. */
const MAX_FEN = Number.MAX_SAFE_INTEGER;
const YUAN_TEXT = /^(?<sign>-?)(?<whole>\d+)(?:\.(?<frac>\d{1,2}))?$/u;

export type ParsedYuan =
  Readonly<{ ok: true; fen: number }> | Readonly<{ ok: false; message: string }>;

/**
 * Yuan text ("15", "15.5", "15.50") → integer fen.
 *
 * Parsed digit-by-digit rather than through `Number(text) * 100`: the float
 * round-trip turns "8.29" into 828.9999… and silently loses a fen.
 */
export function parseYuanToFen(text: string): ParsedYuan {
  const trimmed = text.trim();
  if (trimmed.length === 0) return Object.freeze({ ok: false as const, message: "请输入金额" });
  const groups = YUAN_TEXT.exec(trimmed)?.groups;
  if (groups === undefined) {
    return Object.freeze({ ok: false as const, message: "金额格式为元，最多两位小数（如 15.00）" });
  }
  const whole = Number(groups["whole"]);
  const frac = Number((groups["frac"] ?? "").padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(whole) || whole > Math.floor(MAX_FEN / 100)) {
    return Object.freeze({ ok: false as const, message: "金额超出系统支持范围" });
  }
  const magnitude = whole * 100 + frac;
  if (!Number.isSafeInteger(magnitude)) {
    return Object.freeze({ ok: false as const, message: "金额超出系统支持范围" });
  }
  return Object.freeze({ ok: true as const, fen: groups["sign"] === "-" ? -magnitude : magnitude });
}
