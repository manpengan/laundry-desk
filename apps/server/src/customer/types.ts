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
}>;
