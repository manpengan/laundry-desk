/**
 * M2 customer archive types (org-scoped memory / future PG).
 */

export type CustomerRecord = Readonly<{
  customer_id: string;
  phone: string;
  name: string | null;
  note: string | null;
  version: number;
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
  version: number;
  updated_at: number;
}>;

export type CustomerUpdateInput = Readonly<{
  customer_id: string;
  expected_version: number;
  phone?: string;
  name?: string | null;
  note?: string | null;
  now: number;
}>;

export type CustomerMergeInput = Readonly<{
  source_customer_id: string;
  target_customer_id: string;
  store_id: string;
  staff_id: string;
  now: number;
}>;

export type CustomerMergeResult = Readonly<{
  source_customer_id: string;
  target_customer_id: string;
  relinked_order_count: number;
}>;

export type CustomerMemberAccountMergeOutcome = "no_account" | "relinked" | "conflict";

/**
 * Synchronous by design: the memory customer row and member ownership change
 * in one uninterrupted event-loop turn, matching the SQL transaction boundary.
 */
export type CustomerMemberAccountMergePort = Readonly<{
  mergeCustomerMemberAccount: (
    sourceCustomerId: string,
    targetCustomerId: string,
  ) => CustomerMemberAccountMergeOutcome;
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
  format_version: 2;
  exported_at: number;
  customer: Readonly<{
    customer_id: string;
    phone: string;
    name: string | null;
    note: string | null;
    created_at: number;
    updated_at: number;
  }>;
  canonical_customers: readonly Readonly<{
    customer_id: string;
    phone: string;
    name: string | null;
    note: string | null;
    merged_into_id: string | null;
    created_at: number;
    updated_at: number;
  }>[];
  canonical_customer_count: number;
  profile: Readonly<Record<string, unknown>> | null;
  profiles: readonly Readonly<Record<string, unknown>>[];
  profile_count: number;
  profiles_truncated: boolean;
  addresses: readonly Readonly<Record<string, unknown>>[];
  address_count: number;
  addresses_truncated: boolean;
  retired_address_count: number;
  identifiers: readonly Readonly<Record<string, unknown>>[];
  identifier_count: number;
  identifiers_truncated: boolean;
  retired_identifier_count: number;
  related_narratives: readonly Readonly<Record<string, unknown>>[];
  related_narrative_count: number;
  related_narratives_truncated: boolean;
  retained_garment_photo_count: number;
  notification_deliveries: readonly Readonly<Record<string, unknown>>[];
  notification_delivery_count: number;
  notification_deliveries_truncated: boolean;
  factory_handoff_evidence: readonly Readonly<Record<string, unknown>>[];
  factory_handoff_evidence_count: number;
  factory_handoff_evidence_truncated: boolean;
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
  /** Canonical helpers are optional only for legacy test doubles. */
  resolveCanonicalId?: (customerId: string) => Promise<string | null>;
  listCanonicalGroup?: (customerId: string) => Promise<readonly string[]>;
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

/** Stable internal signal translated to the public non-retryable CUSTOMER_ERASED error. */
export class CustomerErasedError extends Error {
  constructor() {
    super("CUSTOMER_ERASED");
    this.name = "CustomerErasedError";
  }
}
