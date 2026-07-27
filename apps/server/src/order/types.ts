/**
 * M2 skeleton order/garment/payment records (runtime, not contracts).
 * OrderStore is async so memory and Postgres backends share one interface.
 */

import type { GarmentStatus, PaymentMethod, PaymentRow } from "@laundry/domain";

export type OrderStatus = "draft" | "open" | "closed" | "cancelled";

export type LedgerPaymentRow = PaymentRow &
  Readonly<{
    /** Server-derived store business day of the immutable payment ledger row. */
    business_date?: string;
  }>;

export type { PaymentMethod, PaymentRow };

export type PickupApplyOptions = Readonly<{
  staffId: string;
  method?: PaymentMethod;
  /** Domain pickup plan result; verified against the transaction's current rows. */
  nextOrderStatus?: OrderStatus;
  /** Domain pickup plan result; prevents applying a stale payment balance. */
  nextBalanceCents?: number;
  /** Override UUID generation for the payment row (tests). */
  paymentId?: string;
  /** Server-derived store business date for the appended collection row. */
  businessDate?: string;
}>;

export type InitialPayment = Readonly<{
  payment: LedgerPaymentRow;
  business_date: string;
}>;

export type PaymentAppendInput = Readonly<{
  org_id: string;
  store_id: string;
  order_id: string;
  amount_cents: number;
  method: PaymentMethod;
  note: string | null;
  kind: "pay" | "repay";
  staff_id: string;
  at: number;
  business_date: string;
}>;

export type PaymentAppendResult = Readonly<{
  order: OrderRecord;
  payment: LedgerPaymentRow;
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
  ticket_no: string | null;
  status: OrderStatus;
  customer_phone: string | null;
  customer_name: string | null;
  note: string | null;
  lines: readonly OrderLineRecord[];
  subtotal_cents: number;
  original_cents: number;
  discount_cents: number;
  addon_cents: number;
  urgent_cents: number;
  freight_cents: number;
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
  created_at: number;
  updated_at: number;
  business_date: string;
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
  ticket_no: string | null;
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

export type OrderStore = Readonly<{
  insertOrder: (
    order: OrderRecord,
    garments: readonly GarmentRecord[],
    initialPayment?: InitialPayment,
  ) => Promise<void>;
  /** Create a draft or atomically replace the same existing draft. */
  replaceDraft?: (
    order: OrderRecord,
    garments: readonly GarmentRecord[],
    initialPayment?: InitialPayment,
  ) => Promise<boolean>;
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
  appendPayment?: (input: PaymentAppendInput) => Promise<PaymentAppendResult | null>;
  cancelOpenOrder?: (
    orgId: string,
    storeId: string,
    orderId: string,
    reason: string,
    staffId: string,
    at: number,
    businessDate: string,
  ) => Promise<OrderRecord | null>;
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
  ) => Promise<readonly LedgerPaymentRow[]>;
}>;
