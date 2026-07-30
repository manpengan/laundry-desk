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
  opening_float_cents: number;
  counted_cash_cents: number;
  retained_float_cents: number;
  expected_cash_cents: number;
  cash_difference_cents: number;
  signature_name: string;
  period_started_at: number;
  period_ended_at: number;
  /** Epoch seconds. */
  closed_at: number;
}>;

export type ShiftCloseSnapshot = Readonly<{
  order_count: number;
  payable_cents: number;
  paid_cents: number;
  payment_cents: number;
  opening_float_cents?: number;
  counted_cash_cents?: number;
  retained_float_cents?: number;
  expected_cash_cents?: number;
  cash_difference_cents?: number;
  period_started_at?: number;
  period_ended_at?: number;
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
  getMostRecent: (orgId: string, storeId: string) => Promise<ShiftClosingRecord | null>;
  listHistory: (
    orgId: string,
    storeId: string,
    dateFrom: string,
    dateTo: string,
    limit: number,
  ) => Promise<readonly ShiftClosingRecord[]>;
}>;
