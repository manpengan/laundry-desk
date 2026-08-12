export type PricingAddonSnapshotView = Readonly<{
  code: string;
  name: string;
  unit_price_cents: number;
}>;

export type OrderGetPieceDetail = Readonly<{
  color: string | null;
  brand: string | null;
  defects: readonly string[];
  accessories: readonly string[];
  note: string | null;
  addons: readonly PricingAddonSnapshotView[];
}>;

export type OrderGetLine = Readonly<{
  line_index: number;
  service_code: string;
  category_code: string;
  unit_price_cents: number;
  qty: number;
  line_total_cents: number;
  color: string | null;
  brand: string | null;
  garments: readonly OrderGetPieceDetail[];
}>;

export type OrderGetGarment = OrderGetPieceDetail &
  Readonly<{
    garment_id: string;
    barcode: string;
    status: string;
    line_index: number;
    seq: number;
    service_code: string;
    category_code: string;
    unit_price_cents: number;
    rack_zone: string | null;
    rack_slot: string | null;
  }>;

export type OrderGetResult = OrderPolicySnapshotView &
  Readonly<{
    order_id: string;
    customer_id: string | null;
    ticket_no: string | null;
    pickup_code: string | null;
    status: string;
    customer_phone: string | null;
    customer_name: string | null;
    note: string | null;
    subtotal_cents: number;
    original_cents: number;
    discount_cents: number;
    addon_cents: number;
    urgent_cents: number;
    freight_cents: number;
    pricing_policy_version: number;
    urgent_selected: boolean;
    freight_selected: boolean;
    payable_cents: number;
    paid_cents: number;
    balance_cents: number;
    lines: readonly OrderGetLine[];
    garments: readonly OrderGetGarment[];
  }>;

const CODE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ORDER_STATUSES = new Set(["draft", "open", "closed", "cancelled"]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveInt(value: unknown, max: number): number | null {
  const parsed = nonNegativeInt(value);
  return parsed !== null && parsed >= 1 && parsed <= max ? parsed : null;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : undefined;
}

function boundedNullableString(value: unknown, max: number): string | null | undefined {
  const parsed = nullableString(value);
  return typeof parsed === "string" && parsed.length > max ? undefined : parsed;
}

function stringList(value: unknown): readonly string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > 12 ||
    value.some(
      (item) => typeof item !== "string" || item.trim().length < 1 || item.trim().length > 32,
    )
  ) {
    return null;
  }
  return Object.freeze([...value] as string[]);
}

function addonList(value: unknown): readonly PricingAddonSnapshotView[] | null {
  if (!Array.isArray(value) || value.length > 8) return null;
  const addons: PricingAddonSnapshotView[] = [];
  for (const item of value) {
    const row = record(item);
    const unitPrice = nonNegativeInt(row?.unit_price_cents);
    if (
      row === null ||
      typeof row.code !== "string" ||
      !CODE_RE.test(row.code) ||
      typeof row.name !== "string" ||
      row.name.trim().length < 1 ||
      row.name.trim().length > 64
    ) {
      return null;
    }
    if (unitPrice === null) return null;
    addons.push(Object.freeze({ code: row.code, name: row.name, unit_price_cents: unitPrice }));
  }
  return new Set(addons.map((addon) => addon.code)).size === addons.length
    ? Object.freeze(addons)
    : null;
}

function pieceDetail(value: unknown): OrderGetPieceDetail | null {
  const row = record(value);
  if (row === null) return null;
  const color = boundedNullableString(row.color, 32);
  const brand = boundedNullableString(row.brand, 32);
  const note = boundedNullableString(row.note, 256);
  const defects = stringList(row.defects ?? []);
  const accessories = stringList(row.accessories ?? []);
  const addons = addonList(row.addons ?? []);
  if (color === undefined || brand === undefined || note === undefined) return null;
  if (defects === null || accessories === null || addons === null) return null;
  return Object.freeze({ color, brand, defects, accessories, note, addons });
}

function orderLine(value: unknown): OrderGetLine | null {
  const row = record(value);
  if (row === null) return null;
  const lineIndex = nonNegativeInt(row.line_index);
  const unitPrice = nonNegativeInt(row.unit_price_cents);
  const qty = positiveInt(row.qty, 50);
  const lineTotal = nonNegativeInt(row.line_total_cents);
  const color = boundedNullableString(row.color, 32);
  const brand = boundedNullableString(row.brand, 32);
  if (
    lineIndex === null ||
    unitPrice === null ||
    qty === null ||
    lineTotal === null ||
    color === undefined ||
    brand === undefined ||
    typeof row.service_code !== "string" ||
    !CODE_RE.test(row.service_code) ||
    typeof row.category_code !== "string" ||
    !CODE_RE.test(row.category_code) ||
    lineTotal !== unitPrice * qty ||
    !Array.isArray(row.garments) ||
    row.garments.length !== qty
  ) {
    return null;
  }
  const garments = row.garments.map(pieceDetail);
  if (garments.some((garment) => garment === null)) return null;
  return Object.freeze({
    line_index: lineIndex,
    service_code: row.service_code,
    category_code: row.category_code,
    unit_price_cents: unitPrice,
    qty,
    line_total_cents: lineTotal,
    color,
    brand,
    garments: Object.freeze(garments as OrderGetPieceDetail[]),
  });
}

function orderGarment(value: unknown): OrderGetGarment | null {
  const row = record(value);
  const detail = pieceDetail(row);
  if (row === null || detail === null) return null;
  const lineIndex = nonNegativeInt(row.line_index);
  const seq = positiveInt(row.seq, 50);
  const unitPrice = nonNegativeInt(row.unit_price_cents);
  const rackZone = boundedNullableString(row.rack_zone, 32);
  const rackSlot = boundedNullableString(row.rack_slot, 32);
  if (
    typeof row.garment_id !== "string" ||
    !UUID_RE.test(row.garment_id) ||
    typeof row.barcode !== "string" ||
    row.barcode.length < 1 ||
    row.barcode.length > 64 ||
    typeof row.status !== "string" ||
    row.status.length < 1 ||
    row.status.length > 32 ||
    lineIndex === null ||
    seq === null ||
    unitPrice === null ||
    typeof row.service_code !== "string" ||
    !CODE_RE.test(row.service_code) ||
    typeof row.category_code !== "string" ||
    !CODE_RE.test(row.category_code) ||
    rackZone === undefined ||
    rackSlot === undefined
  ) {
    return null;
  }
  return Object.freeze({
    ...detail,
    garment_id: row.garment_id,
    barcode: row.barcode,
    status: row.status,
    line_index: lineIndex,
    seq,
    service_code: row.service_code,
    category_code: row.category_code,
    unit_price_cents: unitPrice,
    rack_zone: rackZone,
    rack_slot: rackSlot,
  });
}

function optionalMoney(row: Record<string, unknown>, key: string, fallback: number): number | null {
  if (!(key in row)) return fallback;
  return nonNegativeInt(row[key]);
}

export function parseOrderGetResult(raw: unknown): OrderGetResult | null {
  const row = record(raw);
  if (
    row === null ||
    typeof row.order_id !== "string" ||
    !UUID_RE.test(row.order_id) ||
    typeof row.status !== "string" ||
    !ORDER_STATUSES.has(row.status)
  )
    return null;
  const ticketNo = nullableString(row.ticket_no);
  const pickupCode = nullableString(row.pickup_code);
  const payable = nonNegativeInt(row.payable_cents);
  const paid = nonNegativeInt(row.paid_cents);
  const balance = nonNegativeInt(row.balance_cents);
  if (
    ticketNo === undefined ||
    pickupCode === undefined ||
    payable === null ||
    paid === null ||
    balance === null
  ) {
    return null;
  }
  const linesRaw = row.lines ?? [];
  if (
    !Array.isArray(linesRaw) ||
    linesRaw.length > 40 ||
    !Array.isArray(row.garments) ||
    row.garments.length > 2_000
  ) {
    return null;
  }
  const lines = linesRaw.map(orderLine);
  const garments = row.garments.map(orderGarment);
  if (
    lines.some((line) => line === null) ||
    garments.some((garment) => garment === null) ||
    new Set(lines.map((line) => line?.line_index)).size !== lines.length
  )
    return null;
  const subtotal = optionalMoney(row, "subtotal_cents", payable);
  const original = optionalMoney(row, "original_cents", payable);
  const discount = optionalMoney(row, "discount_cents", 0);
  const addon = optionalMoney(row, "addon_cents", 0);
  const urgent = optionalMoney(row, "urgent_cents", 0);
  const freight = optionalMoney(row, "freight_cents", 0);
  const policyVersion = optionalMoney(row, "pricing_policy_version", 0);
  const orderPolicy = parseOrderPolicySnapshot(row, discount ?? 0);
  const financialProjectionMatches =
    row.status === "cancelled" ? paid === 0 && balance === 0 : paid + balance === payable;
  if (
    [subtotal, original, discount, addon, urgent, freight, policyVersion].some((v) => v === null) ||
    orderPolicy === null ||
    !financialProjectionMatches ||
    (original as number) -
      (discount as number) +
      (addon as number) +
      (urgent as number) +
      (freight as number) !==
      payable
  ) {
    return null;
  }
  return Object.freeze({
    ...orderPolicy,
    order_id: row.order_id,
    customer_id: typeof row.customer_id === "string" ? row.customer_id : null,
    ticket_no: ticketNo,
    pickup_code: pickupCode,
    status: row.status,
    customer_phone: typeof row.customer_phone === "string" ? row.customer_phone : null,
    customer_name: typeof row.customer_name === "string" ? row.customer_name : null,
    note: typeof row.note === "string" ? row.note : null,
    subtotal_cents: subtotal as number,
    original_cents: original as number,
    discount_cents: discount as number,
    addon_cents: addon as number,
    urgent_cents: urgent as number,
    freight_cents: freight as number,
    pricing_policy_version: policyVersion as number,
    urgent_selected: typeof row.urgent_selected === "boolean" ? row.urgent_selected : false,
    freight_selected: typeof row.freight_selected === "boolean" ? row.freight_selected : false,
    payable_cents: payable,
    paid_cents: paid,
    balance_cents: balance,
    lines: Object.freeze(lines as OrderGetLine[]),
    garments: Object.freeze(garments as OrderGetGarment[]),
  });
}
import {
  parseOrderPolicySnapshot,
  type OrderPolicySnapshotView,
} from "./order-policy-read-model.js";
