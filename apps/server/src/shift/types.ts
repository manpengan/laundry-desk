/**
 * M2 shift closing types (store-scoped memory / future PG).
 */

export type ShiftClosingRecord = Readonly<{
  shift_id: string;
  org_id: string;
  store_id: string;
  business_date: string;
  closed_by_staff_id: string;
  note: string | null;
  order_count: number;
  payable_cents: number;
  paid_cents: number;
  payment_cents: number;
  signature_name: string;
  /** Epoch seconds. */
  closed_at: number;
}>;

export type ShiftCloseSnapshot = Readonly<{
  order_count: number;
  payable_cents: number;
  paid_cents: number;
  payment_cents: number;
}>;

export type ShiftCloseInput = Readonly<{
  org_id: string;
  store_id: string;
  business_date: string;
  closed_by_staff_id: string;
  signature_name: string;
  note?: string;
  snapshot: ShiftCloseSnapshot;
  /** Epoch seconds. */
  closed_at: number;
  shift_id?: string;
}>;

export type ShiftStore = Readonly<{
  getByBusinessDate: (
    orgId: string,
    storeId: string,
    businessDate: string,
  ) => Promise<ShiftClosingRecord | null>;
  close: (input: ShiftCloseInput) => Promise<ShiftClosingRecord>;
}>;
