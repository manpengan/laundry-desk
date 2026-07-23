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
}>;

export type CustomerSearchRow = Readonly<{
  customer_id: string;
  phone: string;
  name: string | null;
  note: string | null;
  updated_at: number;
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
}>;
