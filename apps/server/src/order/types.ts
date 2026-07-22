/**
 * M2 skeleton in-memory order/garment records (runtime, not contracts).
 */

import type { GarmentStatus } from "@laundry/domain";

export type OrderStatus = "open" | "closed" | "cancelled";

export type OrderLineRecord = Readonly<{
  line_index: number;
  service_code: string;
  category_code: string;
  unit_price_cents: number;
  qty: number;
  line_total_cents: number;
  color: string | null;
  brand: string | null;
}>;

export type GarmentRecord = Readonly<{
  garment_id: string;
  order_id: string;
  org_id: string;
  store_id: string;
  line_index: number;
  seq: number;
  barcode: string;
  service_code: string;
  category_code: string;
  unit_price_cents: number;
  color: string | null;
  brand: string | null;
  status: GarmentStatus;
}>;

export type OrderRecord = Readonly<{
  order_id: string;
  org_id: string;
  store_id: string;
  ticket_no: string;
  status: OrderStatus;
  customer_phone: string | null;
  customer_name: string | null;
  note: string | null;
  lines: readonly OrderLineRecord[];
  subtotal_cents: number;
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
  created_at: number;
  updated_at: number;
  created_by_staff_id: string;
}>;

export type OrderStore = Readonly<{
  insertOrder: (order: OrderRecord, garments: readonly GarmentRecord[]) => void;
  getOrder: (orgId: string, storeId: string, orderId: string) => OrderRecord | null;
  listGarments: (orgId: string, storeId: string, orderId: string) => readonly GarmentRecord[];
  applyPickup: (
    orgId: string,
    storeId: string,
    orderId: string,
    garmentIds: readonly string[],
    collectCents: number,
    nowEpoch: number,
  ) => Readonly<{ order: OrderRecord; garments: readonly GarmentRecord[] }> | null;
  nextTicketSeq: (orgId: string, storeId: string, dayKey: string) => number;
}>;
