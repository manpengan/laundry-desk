/**
 * M2 skeleton order/garment/payment records (runtime, not contracts).
 * OrderStore is async so memory and Postgres backends share one interface.
 */

import type { GarmentStatus, PaymentMethod, PaymentRow } from "@laundry/domain";

export type OrderStatus = "open" | "closed" | "cancelled";

export type { PaymentMethod, PaymentRow };

export type PickupApplyOptions = Readonly<{
  staffId: string;
  method?: PaymentMethod;
  /** Override UUID generation for the payment row (tests). */
  paymentId?: string;
}>;

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
  /** PG order_lines.id; optional for memory path until insert. */
  order_line_id?: string;
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

export type PickupApplyResult = Readonly<{
  order: OrderRecord;
  garments: readonly GarmentRecord[];
}>;

export type OrderStore = Readonly<{
  insertOrder: (order: OrderRecord, garments: readonly GarmentRecord[]) => Promise<void>;
  getOrder: (orgId: string, storeId: string, orderId: string) => Promise<OrderRecord | null>;
  listGarments: (
    orgId: string,
    storeId: string,
    orderId: string,
  ) => Promise<readonly GarmentRecord[]>;
  applyPickup: (
    orgId: string,
    storeId: string,
    orderId: string,
    garmentIds: readonly string[],
    collectCents: number,
    nowEpoch: number,
    options?: PickupApplyOptions,
  ) => Promise<PickupApplyResult | null>;
  nextTicketSeq: (orgId: string, storeId: string, dayKey: string) => Promise<number>;
  /** Optional ledger read for tests / future queries. */
  listPayments?: (
    orgId: string,
    storeId: string,
    orderId?: string,
  ) => Promise<readonly PaymentRow[]>;
}>;
