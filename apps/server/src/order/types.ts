/**
 * M2 skeleton order/garment/payment records (runtime, not contracts).
 * OrderStore is async so memory and Postgres backends share one interface.
 */

import type { GarmentStatus, PaymentRow } from "@laundry/domain";

export type OrderStatus = "open" | "closed" | "cancelled";

export type { PaymentRow };

export type PickupApplyOptions = Readonly<{
  /** Authenticated actor used for direct repository calls outside the Bus. */
  staffId: string;
  /** Domain pickup plan result; verified against the transaction's current rows. */
  nextOrderStatus?: OrderStatus;
  /** Domain pickup plan result; prevents applying a stale payment balance. */
  nextBalanceCents?: number;
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
  hold_reason: string | null;
  held_at: number | null;
  held_by_staff_id: string | null;
  lines: readonly OrderLineRecord[];
  subtotal_cents: number;
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
  created_at: number;
  updated_at: number;
  created_by_staff_id: string;
}>;

export type OrderListSummaryOptions = Readonly<{
  businessDate?: string;
  status?: OrderStatus;
  customerPhone?: string;
  minBalanceCents?: number;
  limit: number;
}>;

export type OrderListSummary = Readonly<{
  order_id: string;
  ticket_no: string;
  status: OrderStatus;
  customer_phone: string | null;
  customer_name: string | null;
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
  created_at: number;
  garment_count: number;
}>;

export type PickupApplyResult = Readonly<{
  order: OrderRecord;
  garments: readonly GarmentRecord[];
}>;

export type ApplyPaymentSummaryInput = Readonly<{
  orgId: string;
  storeId: string;
  orderId: string;
  staffId: string;
  expectedPaidCents: number;
  expectedBalanceCents: number;
  paidCents: number;
  balanceCents: number;
  nextStatus: OrderStatus;
  nowEpoch: number;
}>;

export type HoldOrderInput = Readonly<{
  orgId: string;
  storeId: string;
  orderId: string;
  staffId: string;
  reason: string;
  nowEpoch: number;
}>;

export type CancelOrderInput = ApplyPaymentSummaryInput &
  Readonly<{
    reason: string;
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
  /**
   * List all orders for an org/store (day stats / reports).
   * Optional so older test doubles stay valid; memory + PG implement it.
   */
  listOrders?: (orgId: string, storeId: string) => Promise<readonly OrderRecord[]>;
  /** Optimized order.list read model; PG implements this as one aggregate query. */
  listOrderSummaries?: (
    orgId: string,
    storeId: string,
    options: OrderListSummaryOptions,
  ) => Promise<readonly OrderListSummary[]>;
  /** Optional ledger read for tests / stats / future queries. */
  listPayments?: (
    orgId: string,
    storeId: string,
    orderId?: string,
  ) => Promise<readonly PaymentRow[]>;
  /** CAS update of the materialized ledger projection; false means stale state. */
  applyPaymentSummary?: (input: ApplyPaymentSummaryInput) => Promise<boolean>;
  /** Hold remains frozen-contract status=open and records its mandatory reason. */
  holdOrder?: (input: HoldOrderInput) => Promise<boolean>;
  /** Cancel only an unchanged open order; payment reversals are written separately. */
  cancelOrder?: (input: CancelOrderInput) => Promise<boolean>;
}>;
