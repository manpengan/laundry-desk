const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type ReceiveGarmentResult = Readonly<{
  garment_id: string;
  barcode: string;
  status: string;
  line_index: number;
  seq: number;
}>;

export type ReceiveOrderResult = Readonly<{
  order_id: string;
  ticket_no: string;
  pickup_code: string;
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
  discount_cents: number;
  discount_source: "none" | "manual" | "customer" | "tier";
  discount_bps: number;
  waivers: Readonly<{
    skip_ticket_print: boolean;
    skip_label_print: boolean;
    skip_rack_assignment: boolean;
  }>;
  garment_count: number;
  garments: readonly ReceiveGarmentResult[];
}>;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeInt(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max
    ? value
    : null;
}

export function parseHoldDraftId(raw: unknown): string | null {
  const row = record(raw);
  return row !== null && typeof row.draft_id === "string" && UUID_RE.test(row.draft_id)
    ? row.draft_id
    : null;
}

export function parseReceiveOrderResult(raw: unknown): ReceiveOrderResult | null {
  const row = record(raw);
  if (row === null || typeof row.order_id !== "string" || !UUID_RE.test(row.order_id)) return null;
  const payable = nonNegativeInt(row.payable_cents, 2_147_483_647);
  const paid = nonNegativeInt(row.paid_cents, 2_147_483_647);
  const balance = nonNegativeInt(row.balance_cents, 2_147_483_647);
  const discount = nonNegativeInt(row.discount_cents, 2_147_483_647);
  const discountBps = nonNegativeInt(row.discount_bps, 10_000);
  const count = nonNegativeInt(row.garment_count, 2_000);
  const waivers = record(row.waivers);
  const discountSources = new Set(["none", "manual", "customer", "tier"]);
  if (
    typeof row.ticket_no !== "string" ||
    row.ticket_no.length < 1 ||
    row.ticket_no.length > 64 ||
    typeof row.pickup_code !== "string" ||
    row.pickup_code.length < 1 ||
    row.pickup_code.length > 64 ||
    payable === null ||
    paid === null ||
    balance === null ||
    discount === null ||
    typeof row.discount_source !== "string" ||
    !discountSources.has(row.discount_source) ||
    discountBps === null ||
    waivers === null ||
    typeof waivers.skip_ticket_print !== "boolean" ||
    typeof waivers.skip_label_print !== "boolean" ||
    typeof waivers.skip_rack_assignment !== "boolean" ||
    count === null ||
    paid + balance !== payable ||
    !Array.isArray(row.garments) ||
    row.garments.length !== count
  ) {
    return null;
  }
  const garments: ReceiveGarmentResult[] = [];
  for (const value of row.garments) {
    const garment = record(value);
    const lineIndex = nonNegativeInt(garment?.line_index, 39);
    const seq = nonNegativeInt(garment?.seq, 50);
    if (
      garment === null ||
      typeof garment.garment_id !== "string" ||
      !UUID_RE.test(garment.garment_id) ||
      typeof garment.barcode !== "string" ||
      garment.barcode.length < 1 ||
      garment.barcode.length > 64 ||
      typeof garment.status !== "string" ||
      garment.status.length < 1 ||
      garment.status.length > 32 ||
      lineIndex === null ||
      seq === null ||
      seq < 1
    ) {
      return null;
    }
    garments.push(
      Object.freeze({
        garment_id: garment.garment_id,
        barcode: garment.barcode,
        status: garment.status,
        line_index: lineIndex,
        seq,
      }),
    );
  }
  if (
    new Set(garments.map((garment) => garment.garment_id)).size !== garments.length ||
    new Set(garments.map((garment) => garment.barcode)).size !== garments.length
  ) {
    return null;
  }
  return Object.freeze({
    order_id: row.order_id,
    ticket_no: row.ticket_no,
    pickup_code: row.pickup_code,
    payable_cents: payable,
    paid_cents: paid,
    balance_cents: balance,
    discount_cents: discount,
    discount_source: row.discount_source as ReceiveOrderResult["discount_source"],
    discount_bps: discountBps,
    waivers: Object.freeze({
      skip_ticket_print: waivers.skip_ticket_print as boolean,
      skip_label_print: waivers.skip_label_print as boolean,
      skip_rack_assignment: waivers.skip_rack_assignment as boolean,
    }),
    garment_count: count,
    garments: Object.freeze(garments),
  });
}
