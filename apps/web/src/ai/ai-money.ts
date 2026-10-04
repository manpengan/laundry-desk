/**
 * AI budgets and prices are stored as micro-units (1 unit = 1,000,000) of the provider's
 * billing currency. Owners type and read them in 元; string arithmetic keeps them exact.
 */
const AMOUNT = /^(\d{1,9})(?:\.(\d{1,6}))?$/u;

/** Positive micro-units for an amount such as "2" or "0.5"; null when unusable. */
export function yuanToMicros(text: string): number | null {
  const match = AMOUNT.exec(text.trim());
  if (match === null) return null;
  const micros = Number(match[1]) * 1_000_000 + Number((match[2] ?? "").padEnd(6, "0"));
  return Number.isSafeInteger(micros) && micros > 0 ? micros : null;
}

/** Shortest exact decimal text for micro-units: 500000 → "0.5", 2000000 → "2". */
export function microsToYuan(micros: number): string {
  if (!Number.isSafeInteger(micros) || micros < 0) return "";
  const whole = Math.floor(micros / 1_000_000);
  const fraction = String(micros % 1_000_000)
    .padStart(6, "0")
    .replace(/0+$/u, "");
  return fraction === "" ? String(whole) : `${whole}.${fraction}`;
}
