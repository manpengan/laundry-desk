/**
 * M2 customer archive types (org-scoped memory / future PG).
 */

export type CustomerRecord = Readonly<{
  customer_id: string;
  phone: string;
  name: string | null;
  note: string | null;
  created_at: number;
  updated_at: number;
  merged_into_id: string | null;
  anonymized_at?: number | null;
}>;

export type CustomerSearchRow = Readonly<{
  customer_id: string;
  phone: string;
  name: string | null;
  note: string | null;
  updated_at: number;
}>;

export type CustomerUpdateInput = Readonly<{
  customer_id: string;
  phone?: string;
  name?: string | null;
  note?: string | null;
  now: number;
}>;

export type CustomerMergeInput = Readonly<{
  source_customer_id: string;
  target_customer_id: string;
  store_id: string;
  now: number;
}>;

export type CustomerMergeResult = Readonly<{
  source_customer_id: string;
  target_customer_id: string;
  relinked_order_count: number;
}>;

export type CustomerPrivacyStatus = Readonly<{
  customer_id: string;
  active_order_count: number;
  retained_order_count: number;
  photo_count: number;
  latest_order_at: number | null;
  anonymization_eligible: boolean;
}>;

export type CustomerPrivacyEvent = Readonly<{
  event_id: string;
  customer_id: string;
  action: "exported" | "anonymized";
  reason: string;
  affected_order_count: number;
  created_at: number;
}>;

export type CustomerPrivacyExport = Readonly<{
  format_version: 1;
  exported_at: number;
  customer: Readonly<{
    customer_id: string;
    phone: string;
    name: string | null;
    note: string | null;
    created_at: number;
    updated_at: number;
  }>;
  orders: readonly Readonly<Record<string, unknown>>[];
  order_count: number;
  truncated: boolean;
}>;

export type CustomerPrivacyActionInput = Readonly<{
  customer_id: string;
  store_id: string;
  staff_id: string;
  reason: string;
  event_id: string;
  now: number;
}>;

export type CustomerAnonymizeResult = Readonly<{
  customer_id: string;
  affected_order_count: number;
}>;

export type CustomerUpsertInput = Readonly<{
  phone: string;
  name?: string;
  note?: string;
  now?: number;
  customer_id?: string;
}>;

export type CustomerUpsertOutcome = Readonly<{
  customer: CustomerRecord;
  created: boolean;
}>;

export type CustomerStore = Readonly<{
  search: (query: string | undefined, limit: number) => Promise<readonly CustomerSearchRow[]>;
  upsert: (input: CustomerUpsertInput) => Promise<CustomerUpsertOutcome>;
  getByPhone: (phone: string) => Promise<CustomerRecord | null>;
  getById: (customerId: string) => Promise<CustomerRecord | null>;
  update: (input: CustomerUpdateInput) => Promise<CustomerRecord | null>;
  merge: (input: CustomerMergeInput) => Promise<CustomerMergeResult | null>;
  findDuplicates: (customerId: string, limit: number) => Promise<readonly CustomerSearchRow[]>;
  privacyStatus: (
    customerId: string,
    storeId: string,
    staffId: string,
  ) => Promise<CustomerPrivacyStatus | null>;
  listPrivacyEvents: (
    customerId: string,
    limit: number,
  ) => Promise<readonly CustomerPrivacyEvent[]>;
  exportPrivacy: (input: CustomerPrivacyActionInput) => Promise<CustomerPrivacyExport | null>;
  anonymize: (input: CustomerPrivacyActionInput) => Promise<CustomerAnonymizeResult | null>;
}>;
