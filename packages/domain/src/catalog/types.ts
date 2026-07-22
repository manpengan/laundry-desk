/**
 * Catalog item shape (M2 skeleton) — service × category price row.
 * Integer cents only; codes are ASCII; display names may be Chinese.
 */

export type CatalogItem = Readonly<{
  /** Stable ASCII product code (e.g. wash_shirt). */
  code: string;
  /** Counter display name (Chinese ok). */
  name: string;
  /** Service type code (e.g. wash, dry, iron). */
  service_code: string;
  /** Garment category code (e.g. shirt, coat). */
  category_code: string;
  /** Unit price in integer fen/cents (non-negative). */
  unit_price_cents: number;
  /** Optional keyboard mnemonic (助记码), case-insensitive match. */
  mnemonic?: string;
}>;
