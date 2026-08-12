/** Stable exact-match normalization for vehicle plates, tags and external ids. */
export function normalizeCustomerIdentifier(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLocaleUpperCase("en-US")
    .replace(/[\s-]+/gu, "");
}
