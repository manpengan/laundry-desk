/**
 * SQL row ↔ order domain mappers for laundry_app order tables.
 */

import type { GarmentStatus } from "@laundry/domain";

import type { GarmentRecord, OrderLineRecord, OrderRecord, OrderStatus } from "./types.js";

export const epochToDate = (epoch: number): Date => new Date(epoch * 1000);

export const dateToEpoch = (value: Date | string): number => {
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Math.floor(ms / 1000);
};

export type OrderRow = {
  id: string;
  org_id: string;
  store_id: string;
  ticket_no: string;
  status: string;
  customer_phone: string | null;
  customer_name: string | null;
  note: string | null;
  hold_reason?: string | null;
  held_at?: Date | string | null;
  held_by_staff_id?: string | null;
  subtotal_cents: number;
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
  created_at: Date | string;
  updated_at: Date | string;
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
  status: string;
};

const ORDER_STATUSES = new Set<OrderStatus>(["open", "closed", "cancelled"]);

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
  });
}

export function mapOrder(row: OrderRow, lines: readonly OrderLineRecord[]): OrderRecord {
  return Object.freeze({
    order_id: row.id,
    org_id: row.org_id,
    store_id: row.store_id,
    ticket_no: row.ticket_no,
    status: asOrderStatus(row.status),
    customer_phone: row.customer_phone,
    customer_name: row.customer_name,
    note: row.note,
    hold_reason: row.hold_reason ?? null,
    held_at: row.held_at === null || row.held_at === undefined ? null : dateToEpoch(row.held_at),
    held_by_staff_id: row.held_by_staff_id ?? null,
    lines: Object.freeze([...lines]),
    subtotal_cents: row.subtotal_cents,
    payable_cents: row.payable_cents,
    paid_cents: row.paid_cents,
    balance_cents: row.balance_cents,
    created_at: dateToEpoch(row.created_at),
    updated_at: dateToEpoch(row.updated_at),
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
    status: asGarmentStatus(row.status),
  });
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
