import { CUSTOMER_PRIVACY_REASON_CODES, type CustomerPrivacyReason } from "@laundry/contracts";

import { unwrapQueryResult } from "./customer-model.js";

const PRIVACY_EVENT_REASON_CODES: ReadonlySet<string> = new Set([
  ...CUSTOMER_PRIVACY_REASON_CODES,
  "legacy_request",
]);

export type CustomerPrivacyStatusView = Readonly<{
  customer_id: string;
  active_order_count: number;
  retained_order_count: number;
  photo_count: number;
  latest_order_at: number | null;
  anonymization_eligible: boolean;
}>;

export type CustomerPrivacyEventView = Readonly<{
  event_id: string;
  customer_id: string;
  action: "exported" | "anonymized";
  reason: CustomerPrivacyReason | "legacy_request";
  affected_order_count: number;
  created_at: number;
}>;

export type CustomerPrivacyExportView = Readonly<{
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
  canonical_customers: readonly Readonly<Record<string, unknown>>[];
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function freezeRecords(rows: readonly Readonly<Record<string, unknown>>[]) {
  return Object.freeze(rows.map((row) => Object.freeze({ ...row })));
}

function boundedRowsAreComplete(
  rows: readonly unknown[],
  count: number,
  truncated: boolean,
): boolean {
  return rows.length <= 1000 && count >= rows.length && truncated === count > rows.length;
}

export function parseCustomerPrivacyStatus(value: unknown): CustomerPrivacyStatusView | null {
  const raw = unwrapQueryResult(value);
  if (
    !isRecord(raw) ||
    typeof raw.customer_id !== "string" ||
    !nonNegativeInteger(raw.active_order_count) ||
    !nonNegativeInteger(raw.retained_order_count) ||
    !nonNegativeInteger(raw.photo_count) ||
    !(raw.latest_order_at === null || nonNegativeInteger(raw.latest_order_at)) ||
    typeof raw.anonymization_eligible !== "boolean"
  ) {
    return null;
  }
  return Object.freeze({
    customer_id: raw.customer_id,
    active_order_count: raw.active_order_count,
    retained_order_count: raw.retained_order_count,
    photo_count: raw.photo_count,
    latest_order_at: raw.latest_order_at,
    anonymization_eligible: raw.anonymization_eligible,
  });
}

export function parseCustomerPrivacyEvents(
  value: unknown,
): readonly CustomerPrivacyEventView[] | null {
  const raw = unwrapQueryResult(value);
  if (!isRecord(raw) || !Array.isArray(raw.events)) return null;
  const events: CustomerPrivacyEventView[] = [];
  for (const event of raw.events) {
    if (
      !isRecord(event) ||
      typeof event.event_id !== "string" ||
      typeof event.customer_id !== "string" ||
      (event.action !== "exported" && event.action !== "anonymized") ||
      typeof event.reason !== "string" ||
      !PRIVACY_EVENT_REASON_CODES.has(event.reason) ||
      !nonNegativeInteger(event.affected_order_count) ||
      !nonNegativeInteger(event.created_at)
    ) {
      return null;
    }
    events.push(
      Object.freeze({
        event_id: event.event_id,
        customer_id: event.customer_id,
        action: event.action,
        reason: event.reason as CustomerPrivacyEventView["reason"],
        affected_order_count: event.affected_order_count,
        created_at: event.created_at,
      }),
    );
  }
  return Object.freeze(events);
}

export function parseCustomerPrivacyExport(value: unknown): CustomerPrivacyExportView | null {
  const raw = unwrapQueryResult(value);
  if (
    !isRecord(raw) ||
    raw.format_version !== 2 ||
    !nonNegativeInteger(raw.exported_at) ||
    !isRecord(raw.customer) ||
    typeof raw.customer.customer_id !== "string" ||
    typeof raw.customer.phone !== "string" ||
    !nullableString(raw.customer.name) ||
    !nullableString(raw.customer.note) ||
    !nonNegativeInteger(raw.customer.created_at) ||
    !nonNegativeInteger(raw.customer.updated_at) ||
    !Array.isArray(raw.canonical_customers) ||
    !raw.canonical_customers.every(isRecord) ||
    !nonNegativeInteger(raw.canonical_customer_count) ||
    raw.canonical_customer_count !== raw.canonical_customers.length ||
    !(raw.profile === null || isRecord(raw.profile)) ||
    !Array.isArray(raw.profiles) ||
    !raw.profiles.every(isRecord) ||
    !nonNegativeInteger(raw.profile_count) ||
    typeof raw.profiles_truncated !== "boolean" ||
    !boundedRowsAreComplete(raw.profiles, raw.profile_count, raw.profiles_truncated) ||
    (raw.profile === null) !== (raw.profiles.length === 0) ||
    !Array.isArray(raw.addresses) ||
    !raw.addresses.every(isRecord) ||
    !nonNegativeInteger(raw.address_count) ||
    typeof raw.addresses_truncated !== "boolean" ||
    !boundedRowsAreComplete(raw.addresses, raw.address_count, raw.addresses_truncated) ||
    !nonNegativeInteger(raw.retired_address_count) ||
    !Array.isArray(raw.identifiers) ||
    !raw.identifiers.every(isRecord) ||
    !nonNegativeInteger(raw.identifier_count) ||
    typeof raw.identifiers_truncated !== "boolean" ||
    !boundedRowsAreComplete(raw.identifiers, raw.identifier_count, raw.identifiers_truncated) ||
    !nonNegativeInteger(raw.retired_identifier_count) ||
    !Array.isArray(raw.related_narratives) ||
    !raw.related_narratives.every(isRecord) ||
    !nonNegativeInteger(raw.related_narrative_count) ||
    typeof raw.related_narratives_truncated !== "boolean" ||
    !boundedRowsAreComplete(
      raw.related_narratives,
      raw.related_narrative_count,
      raw.related_narratives_truncated,
    ) ||
    !nonNegativeInteger(raw.retained_garment_photo_count) ||
    !Array.isArray(raw.notification_deliveries) ||
    !raw.notification_deliveries.every(isRecord) ||
    !nonNegativeInteger(raw.notification_delivery_count) ||
    typeof raw.notification_deliveries_truncated !== "boolean" ||
    !boundedRowsAreComplete(
      raw.notification_deliveries,
      raw.notification_delivery_count,
      raw.notification_deliveries_truncated,
    ) ||
    !Array.isArray(raw.factory_handoff_evidence) ||
    !raw.factory_handoff_evidence.every(isRecord) ||
    !nonNegativeInteger(raw.factory_handoff_evidence_count) ||
    typeof raw.factory_handoff_evidence_truncated !== "boolean" ||
    !boundedRowsAreComplete(
      raw.factory_handoff_evidence,
      raw.factory_handoff_evidence_count,
      raw.factory_handoff_evidence_truncated,
    ) ||
    !Array.isArray(raw.orders) ||
    !raw.orders.every(isRecord) ||
    !nonNegativeInteger(raw.order_count) ||
    typeof raw.truncated !== "boolean" ||
    !boundedRowsAreComplete(raw.orders, raw.order_count, raw.truncated)
  ) {
    return null;
  }
  return Object.freeze({
    format_version: 2,
    exported_at: raw.exported_at,
    customer: Object.freeze({
      customer_id: raw.customer.customer_id,
      phone: raw.customer.phone,
      name: raw.customer.name,
      note: raw.customer.note,
      created_at: raw.customer.created_at,
      updated_at: raw.customer.updated_at,
    }),
    canonical_customers: freezeRecords(raw.canonical_customers),
    canonical_customer_count: raw.canonical_customer_count,
    profile: raw.profile === null ? null : Object.freeze({ ...raw.profile }),
    profiles: freezeRecords(raw.profiles),
    profile_count: raw.profile_count,
    profiles_truncated: raw.profiles_truncated,
    addresses: freezeRecords(raw.addresses),
    address_count: raw.address_count,
    addresses_truncated: raw.addresses_truncated,
    retired_address_count: raw.retired_address_count,
    identifiers: freezeRecords(raw.identifiers),
    identifier_count: raw.identifier_count,
    identifiers_truncated: raw.identifiers_truncated,
    retired_identifier_count: raw.retired_identifier_count,
    related_narratives: freezeRecords(raw.related_narratives),
    related_narrative_count: raw.related_narrative_count,
    related_narratives_truncated: raw.related_narratives_truncated,
    retained_garment_photo_count: raw.retained_garment_photo_count,
    notification_deliveries: freezeRecords(raw.notification_deliveries),
    notification_delivery_count: raw.notification_delivery_count,
    notification_deliveries_truncated: raw.notification_deliveries_truncated,
    factory_handoff_evidence: freezeRecords(raw.factory_handoff_evidence),
    factory_handoff_evidence_count: raw.factory_handoff_evidence_count,
    factory_handoff_evidence_truncated: raw.factory_handoff_evidence_truncated,
    orders: freezeRecords(raw.orders),
    order_count: raw.order_count,
    truncated: raw.truncated,
  });
}

export function createCustomerPrivacyExportFile(exported: CustomerPrivacyExportView): Readonly<{
  filename: string;
  contents: string;
}> {
  return Object.freeze({
    filename: `customer-privacy-${exported.customer.customer_id}-${exported.exported_at}.json`,
    contents: `${JSON.stringify(exported, null, 2)}\n`,
  });
}

export function downloadCustomerPrivacyExport(exported: CustomerPrivacyExportView): void {
  const file = createCustomerPrivacyExportFile(exported);
  const url = URL.createObjectURL(
    new Blob([file.contents], { type: "application/json;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
