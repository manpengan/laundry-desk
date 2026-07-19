/** Amounts are integer fen only. Never use float. */

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

export function sumFen(values: readonly number[]): number {
  return values.reduce((acc, v) => {
    if (!Number.isInteger(v)) {
      throw new Error(`amount must be integer fen, got ${v}`);
    }
    return acc + v;
  }, 0);
}
