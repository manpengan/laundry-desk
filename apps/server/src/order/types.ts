/**
 * M2 skeleton order/garment/payment records (runtime, not contracts).
 * OrderStore is async so memory and Postgres backends share one interface.
 */

import type {
  GarmentStatus,
  PaymentLedgerMethod,
  PaymentMethod,
  PaymentRow,
} from "@laundry/domain";

export type OrderStatus = "draft" | "open" | "closed" | "cancelled";

export type LedgerPaymentRow = PaymentRow &
  Readonly<{
    /** Server-derived store business day of the immutable payment ledger row. */
    business_date?: string;
  }>;

export type { PaymentLedgerMethod, PaymentMethod, PaymentRow };

export type PickupApplyOptions = Readonly<{
  staffId: string;
  method?: PaymentMethod;
  /** User-submitted normalized rack barcodes; revalidated after PostgreSQL row locks. */
  verificationBarcodes?: readonly string[];
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
  /** Wider than counter tenders: the member spend path appends `balance`. */
  method: PaymentLedgerMethod;
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

export type PaymentRefundAppendInput = Readonly<{
  org_id: string;
  store_id: string;
  order_id: string;
  amount_cents: number;
  expected_method: PaymentMethod;
  ref_payment_id: string;
  reason: string;
  staff_id: string;
  at: number;
  business_date: string;
}>;

export type FixedCouponDiscountInput = Readonly<{
  org_id: string;
  store_id: string;
  order_id: string;
  customer_id: string;
  discount_cents: number;
  min_order_cents: number;
  at: number;
}>;

export type FixedCouponDiscountResult = Readonly<{
  order: OrderRecord;
  applied_discount_cents: number;
}>;

export type PricingAddonSnapshot = Readonly<{
  code: string;
  name: string;
  unit_price_cents: number;
}>;

export type GarmentDetailRecord = Readonly<{
  color: string | null;
  brand: string | null;
  defects: readonly string[];
  accessories: readonly string[];
  note: string | null;
  addons: readonly PricingAddonSnapshot[];
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
  garment_details?: readonly GarmentDetailRecord[];
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
  defects?: readonly string[];
  accessories?: readonly string[];
  note?: string | null;
  status: GarmentStatus;
  /** Physical custody is independent from the processing lifecycle status. */
  custody_state?: "store" | "to_factory" | "factory" | "to_store" | "exception";
  /** A non-null value reserves the garment for one active factory handoff batch. */
  active_production_batch_id?: string | null;
  rack_zone?: string | null;
  rack_slot?: string | null;
}>;

export type OrderRecord = Readonly<{
  order_id: string;
  org_id: string;
  store_id: string;
  ticket_no: string | null;
  /** Customer-facing receipt code; absent only on an unreceived draft. */
  pickup_code: string | null;
  status: OrderStatus;
  /** Stable org-scoped customer identity; receipt phone/name remain snapshots. */
  customer_id: string | null;
  customer_phone: string | null;
  customer_name: string | null;
  note: string | null;
  lines: readonly OrderLineRecord[];
  subtotal_cents: number;
  original_cents: number;
  discount_cents: number;
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
  addon_cents: number;
  urgent_cents: number;
  freight_cents: number;
  pricing_policy_version?: number;
  urgent_selected?: boolean;
  freight_selected?: boolean;
  payable_cents: number;
  paid_cents: number;
  balance_cents: number;
  /** Formal receipt/open instant; replacing a draft resets this retention clock. */
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

export type OrderLookupMatchKind =
  "ticket_no" | "pickup_code" | "garment_barcode" | "customer_phone" | "customer_name";

export type OrderLookupOptions = Readonly<{
  key: string;
  status?: OrderStatus;
  limit: number;
}>;

export type OrderLookupSummary = OrderListSummary &
  Readonly<{
    pickup_code: string | null;
    matched_by: OrderLookupMatchKind;
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
    options?: Readonly<{ requireExisting?: boolean }>,
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
  appendRefund?: (input: PaymentRefundAppendInput) => Promise<PaymentAppendResult | null>;
  applyFixedCouponDiscount?: (
    input: FixedCouponDiscountInput,
  ) => Promise<FixedCouponDiscountResult | null>;
  cancelOpenOrder?: (
    orgId: string,
    storeId: string,
    orderId: string,
    reason: string,
    staffId: string,
    at: number,
    businessDate: string,
    beforeCommit?: () => Promise<void>,
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
  /** Indexed, bounded identifier lookup for the counter pickup flow. */
  lookupOrderSummaries?: (
    orgId: string,
    storeId: string,
    options: OrderLookupOptions,
  ) => Promise<readonly OrderLookupSummary[]>;
  /** Optional ledger read for tests / stats / future queries. */
  listPayments?: (
    orgId: string,
    storeId: string,
    orderId?: string,
    /** Optional fail-closed read cap for operator query surfaces. */
    limit?: number,
  ) => Promise<readonly LedgerPaymentRow[]>;
}>;
