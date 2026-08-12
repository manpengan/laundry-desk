/**
 * SQL row ↔ order domain mappers for laundry_app order tables.
 */

import type { GarmentStatus } from "@laundry/domain";

import type {
  GarmentDetailRecord,
  GarmentRecord,
  OrderLineRecord,
  OrderRecord,
  OrderStatus,
  PricingAddonSnapshot,
} from "./types.js";

export const epochToDate = (epoch: number): Date => new Date(epoch * 1000);

const CODE_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/u;
const DETAIL_KEYS = Object.freeze(["accessories", "addons", "brand", "color", "defects", "note"]);
const ADDON_KEYS = Object.freeze(["code", "name", "unit_price_cents"]);

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

export const dateToEpoch = (value: Date | string): number => {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Math.floor(ms / 1000);
};

export type OrderRow = {
  id: string;
  org_id: string;
  store_id: string;
  ticket_no: string | null;
  pickup_code: string | null;
  status: string;
  customer_id: string | null;
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
  customer_profile_version?: number;
  discount_source?: "none" | "manual" | "customer" | "tier";
  discount_bps?: number;
  membership_version?: number | null;
  tier_id?: string | null;
  tier_definition_version?: number | null;
  tier_code?: string | null;
  tier_name?: string | null;
  tier_level?: number | null;
  tier_discount_bps?: number | null;
  skip_ticket_print?: boolean;
  skip_label_print?: boolean;
  skip_rack_assignment?: boolean;
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
  created_at: Date | string;
  updated_at: Date | string;
  business_date: string;
  created_by_staff_id: string;
};

export type OrderLineRow = {
  id: string;
  org_id: string;
  store_id: string;
  order_id: string;
  line_index: number;
  service_code: string;
  category_code: string;
  unit_price_cents: number;
  qty: number;
  line_total_cents: number;
  color: string | null;
  brand: string | null;
  garment_details_json: unknown;
};

export type GarmentRow = {
  id: string;
  org_id: string;
  store_id: string;
  order_id: string;
  order_line_id: string;
  line_index: number;
  seq: number;
  barcode: string;
  service_code: string;
  category_code: string;
  unit_price_cents: number;
  color: string | null;
  brand: string | null;
  defects: unknown;
  accessories: unknown;
  note: string | null;
  status: string;
  custody_state?: string;
  active_production_batch_id?: string | null;
  rack_zone: string | null;
  rack_slot: string | null;
};

const ORDER_STATUSES = new Set<OrderStatus>(["draft", "open", "closed", "cancelled"]);

const GARMENT_STATUSES = new Set<GarmentStatus>([
  "received",
  "washing",
  "ready",
  "racked",
  "picked_up",
  "delivered",
  "reworked",
  "lost",
]);

export function asOrderStatus(value: string): OrderStatus {
  if (!ORDER_STATUSES.has(value as OrderStatus)) {
    throw new Error(`Unknown order status: ${value}`);
  }
  return value as OrderStatus;
}

export function asGarmentStatus(value: string): GarmentStatus {
  if (!GARMENT_STATUSES.has(value as GarmentStatus)) {
    throw new Error(`Unknown garment status: ${value}`);
  }
  return value as GarmentStatus;
}

export function mapOrderLine(row: OrderLineRow): OrderLineRecord {
  return Object.freeze({
    line_index: row.line_index,
    service_code: row.service_code,
    category_code: row.category_code,
    unit_price_cents: row.unit_price_cents,
    qty: row.qty,
    line_total_cents: row.line_total_cents,
    color: row.color,
    brand: row.brand,
    garment_details: parseGarmentDetails(row.garment_details_json, row.qty, row.color, row.brand),
  });
}

export function mapOrder(row: OrderRow, lines: readonly OrderLineRecord[]): OrderRecord {
  return Object.freeze({
    order_id: row.id,
    org_id: row.org_id,
    store_id: row.store_id,
    ticket_no: row.ticket_no,
    pickup_code: row.pickup_code,
    status: asOrderStatus(row.status),
    customer_id: row.customer_id,
    customer_phone: row.customer_phone,
    customer_name: row.customer_name,
    note: row.note,
    lines: Object.freeze([...lines]),
    subtotal_cents: row.subtotal_cents,
    original_cents: row.original_cents,
    discount_cents: row.discount_cents,
    addon_cents: row.addon_cents,
    urgent_cents: row.urgent_cents,
    freight_cents: row.freight_cents,
    pricing_policy_version: row.pricing_policy_version,
    urgent_selected: row.urgent_selected,
    freight_selected: row.freight_selected,
    customer_profile_version: row.customer_profile_version ?? 0,
    discount_source: row.discount_source ?? (row.discount_cents > 0 ? "manual" : "none"),
    discount_bps: row.discount_bps ?? 0,
    membership_version: row.membership_version ?? null,
    tier_id: row.tier_id ?? null,
    tier_definition_version: row.tier_definition_version ?? null,
    tier_code: row.tier_code ?? null,
    tier_name: row.tier_name ?? null,
    tier_level: row.tier_level ?? null,
    tier_discount_bps: row.tier_discount_bps ?? null,
    skip_ticket_print: row.skip_ticket_print ?? false,
    skip_label_print: row.skip_label_print ?? false,
    skip_rack_assignment: row.skip_rack_assignment ?? false,
    payable_cents: row.payable_cents,
    paid_cents: row.paid_cents,
    balance_cents: row.balance_cents,
    created_at: dateToEpoch(row.created_at),
    updated_at: dateToEpoch(row.updated_at),
    business_date: row.business_date,
    created_by_staff_id: row.created_by_staff_id,
  });
}

export function mapGarment(row: GarmentRow): GarmentRecord {
  return Object.freeze({
    garment_id: row.id,
    order_id: row.order_id,
    org_id: row.org_id,
    store_id: row.store_id,
    line_index: row.line_index,
    order_line_id: row.order_line_id,
    seq: row.seq,
    barcode: row.barcode,
    service_code: row.service_code,
    category_code: row.category_code,
    unit_price_cents: row.unit_price_cents,
    color: row.color,
    brand: row.brand,
    defects: parseStringArray(row.defects, "garment defects"),
    accessories: parseStringArray(row.accessories, "garment accessories"),
    note: row.note,
    status: asGarmentStatus(row.status),
    custody_state:
      row.custody_state === "to_factory" ||
      row.custody_state === "factory" ||
      row.custody_state === "to_store" ||
      row.custody_state === "exception"
        ? row.custody_state
        : "store",
    active_production_batch_id: row.active_production_batch_id ?? null,
    rack_zone: row.rack_zone,
    rack_slot: row.rack_slot,
  });
}

function asObject(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Invalid ${field}`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function parseStringArray(value: unknown, field: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > 12 ||
    value.some(
      (item) =>
        typeof item !== "string" || item.length < 1 || item.length > 32 || item.trim() !== item,
    )
  ) {
    throw new TypeError(`Invalid ${field}`);
  }
  return Object.freeze([...value]);
}

function nullableText(value: unknown, field: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > max) throw new TypeError(`Invalid ${field}`);
  return value;
}

function parseAddonSnapshots(value: unknown): readonly PricingAddonSnapshot[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw new TypeError("Invalid garment add-ons");
  }
  const addons = Object.freeze(
    value.map((entry) => {
      const addon = asObject(entry, "garment add-on");
      if (
        !hasExactKeys(addon, ADDON_KEYS) ||
        typeof addon.code !== "string" ||
        !CODE_RE.test(addon.code) ||
        typeof addon.name !== "string" ||
        addon.name.length < 1 ||
        addon.name.length > 64 ||
        typeof addon.unit_price_cents !== "number" ||
        !Number.isSafeInteger(addon.unit_price_cents) ||
        addon.unit_price_cents < 0 ||
        addon.unit_price_cents > 2_147_483_647
      ) {
        throw new TypeError("Invalid garment add-on");
      }
      return Object.freeze({
        code: addon.code,
        name: addon.name,
        unit_price_cents: addon.unit_price_cents,
      });
    }),
  );
  if (new Set(addons.map((addon) => addon.code)).size !== addons.length) {
    throw new TypeError("Duplicate garment add-on");
  }
  return addons;
}

function parseGarmentDetail(value: unknown): GarmentDetailRecord {
  const detail = asObject(value, "garment detail");
  if (!hasExactKeys(detail, DETAIL_KEYS)) throw new TypeError("Invalid garment detail");
  return Object.freeze({
    color: nullableText(detail.color, "garment color", 32),
    brand: nullableText(detail.brand, "garment brand", 32),
    defects: parseStringArray(detail.defects ?? [], "garment defects"),
    accessories: parseStringArray(detail.accessories ?? [], "garment accessories"),
    note: nullableText(detail.note, "garment note", 256),
    addons: parseAddonSnapshots(detail.addons ?? []),
  });
}

function legacyGarmentDetails(
  qty: number,
  color: string | null,
  brand: string | null,
): readonly GarmentDetailRecord[] {
  return Object.freeze(
    Array.from({ length: qty }, () =>
      Object.freeze({
        color,
        brand,
        defects: Object.freeze([]),
        accessories: Object.freeze([]),
        note: null,
        addons: Object.freeze([]),
      }),
    ),
  );
}

function parseGarmentDetails(
  value: unknown,
  qty: number,
  color: string | null,
  brand: string | null,
): readonly GarmentDetailRecord[] {
  if (!Array.isArray(value)) throw new TypeError("Invalid garment details");
  if (value.length === 0) return legacyGarmentDetails(qty, color, brand);
  if (value.length !== qty) throw new TypeError("Garment detail count does not match quantity");
  return Object.freeze(value.map(parseGarmentDetail));
}

/** Resolve line_index → order_lines.id for insert (generate UUIDs when missing). */
export function buildLineIdByIndex(
  lines: readonly OrderLineRecord[],
  newId: () => string,
): ReadonlyMap<number, string> {
  const map = new Map<number, string>();
  for (const line of lines) {
    map.set(line.line_index, newId());
  }
  return map;
}
