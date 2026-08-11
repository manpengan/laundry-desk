export type ReceiveGarmentDraft = Readonly<{
  key: string;
  color: string;
  brand: string;
  defects_text: string;
  accessories_text: string;
  note: string;
  addon_codes: readonly string[];
}>;

export type ReceiveLineDraft = Readonly<{
  key: string;
  service_code: string;
  category_code: string;
  /** Catalog display price only. Never sent back as an order.receive input. */
  unit_price_cents: number | null;
  qty: string;
  /** Exactly one editable detail row per physical garment. */
  garments: readonly ReceiveGarmentDraft[];
}>;

export function newGarmentDraft(lineKey: string, index: number): ReceiveGarmentDraft {
  return Object.freeze({
    key: `${lineKey}-piece-${index}-${Date.now()}`,
    color: "",
    brand: "",
    defects_text: "",
    accessories_text: "",
    note: "",
    addon_codes: Object.freeze([]),
  });
}

export function resizeGarmentDrafts(
  garments: readonly ReceiveGarmentDraft[],
  qty: number,
  lineKey: string,
): readonly ReceiveGarmentDraft[] {
  if (qty <= garments.length) return Object.freeze(garments.slice(0, qty));
  return Object.freeze([
    ...garments,
    ...Array.from({ length: qty - garments.length }, (_, offset) =>
      newGarmentDraft(lineKey, garments.length + offset),
    ),
  ]);
}

export function newLineDraft(index: number): ReceiveLineDraft {
  const key = `line-${index}-${Date.now()}`;
  return Object.freeze({
    key,
    service_code: "",
    category_code: "",
    unit_price_cents: null,
    qty: "1",
    garments: Object.freeze([newGarmentDraft(key, 0)]),
  });
}
