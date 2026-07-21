/**
 * CODE128 printed width estimate (modules).
 * Formula: start(11) + n*11 + check(11) + stop(13) + quiet 10×2 = 11n + 55.
 */

export const XP58_PRINTABLE_DOTS = 384;

export function estimateCode128Modules(symbolCount: number): number {
  if (!Number.isInteger(symbolCount) || symbolCount < 0) {
    throw new Error(`symbolCount must be non-negative integer, got ${symbolCount}`);
  }
  return 11 * symbolCount + 55;
}

export function estimateCode128Dots(symbolCount: number, moduleWidth: number): number {
  if (!Number.isInteger(moduleWidth) || moduleWidth < 1) {
    throw new Error(`moduleWidth must be positive integer, got ${moduleWidth}`);
  }
  return estimateCode128Modules(symbolCount) * moduleWidth;
}

export function fitsXp58(symbolCount: number, moduleWidth: number): boolean {
  return estimateCode128Dots(symbolCount, moduleWidth) <= XP58_PRINTABLE_DOTS;
}
