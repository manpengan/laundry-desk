const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type BuildPickupBodyResult =
  | Readonly<{ ok: true; body: Readonly<Record<string, unknown>> }>
  | Readonly<{ ok: false; message: string }>;

function validUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function parseCents(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function buildPickupBody(input: {
  order_id: string;
  collect_cents: string;
  garment_ids?: readonly string[];
  garment_ids_text?: string;
  verification_barcodes?: readonly string[];
  require_selection?: boolean;
}): BuildPickupBodyResult {
  const orderId = input.order_id.trim();
  if (!validUuid(orderId)) {
    return Object.freeze({ ok: false as const, message: "订单 ID 须为 UUID" });
  }
  const collect = parseCents(input.collect_cents);
  if (collect === null) {
    return Object.freeze({ ok: false as const, message: "收款金额须为整数分" });
  }
  let garmentIds: string[] = [];
  if (input.garment_ids !== undefined) {
    garmentIds = [...input.garment_ids];
  } else if (input.garment_ids_text !== undefined) {
    garmentIds = input.garment_ids_text
      .trim()
      .split(/[\s,，]+/u)
      .filter((value) => value.length > 0);
  }
  if (garmentIds.length > 200 || garmentIds.some((id) => !validUuid(id))) {
    return Object.freeze({ ok: false as const, message: "件 ID 须为 UUID，最多 200 个" });
  }
  const requireSelection = input.require_selection ?? input.garment_ids !== undefined;
  if (requireSelection && garmentIds.length === 0) {
    return Object.freeze({ ok: false as const, message: "请至少选择一件可取衣物" });
  }
  const verificationBarcodes = (input.verification_barcodes ?? []).map((barcode) =>
    barcode.trim().toUpperCase(),
  );
  if (
    verificationBarcodes.length > 200 ||
    verificationBarcodes.some((barcode) => barcode.length < 1 || barcode.length > 64) ||
    new Set(verificationBarcodes).size !== verificationBarcodes.length
  ) {
    return Object.freeze({ ok: false as const, message: "取衣复核条码无效或重复" });
  }
  return Object.freeze({
    ok: true as const,
    body: Object.freeze({
      order_id: orderId,
      collect_cents: collect,
      garment_ids: Object.freeze(garmentIds),
      verification_barcodes: Object.freeze(verificationBarcodes),
    }),
  });
}
