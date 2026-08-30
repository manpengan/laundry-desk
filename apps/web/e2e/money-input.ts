/**
 * Money fields render and accept yuan (see packages/ui MoneyInput); the specs
 * keep their fixtures and assertions in integer fen. Wrap every `fill` of a
 * money input with this so the two stay in sync from one place.
 */
export function yuanText(fen: number | string): string {
  const amount = typeof fen === "string" ? Number(fen) : fen;
  if (!Number.isInteger(amount)) {
    throw new Error(`money fixture must be integer fen, got ${String(fen)}`);
  }
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  return `${sign}${Math.floor(abs / 100)}.${(abs % 100).toString().padStart(2, "0")}`;
}
