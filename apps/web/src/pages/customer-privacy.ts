import { unwrapQueryResult } from "./customer-model.js";

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
  reason: string;
  affected_order_count: number;
  created_at: number;
}>;

export type CustomerPrivacyExportView = Readonly<{
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
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
        reason: event.reason,
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
    raw.format_version !== 1 ||
    !nonNegativeInteger(raw.exported_at) ||
    !isRecord(raw.customer) ||
    typeof raw.customer.customer_id !== "string" ||
    typeof raw.customer.phone !== "string" ||
    !nullableString(raw.customer.name) ||
    !nullableString(raw.customer.note) ||
    !nonNegativeInteger(raw.customer.created_at) ||
    !nonNegativeInteger(raw.customer.updated_at) ||
    !Array.isArray(raw.orders) ||
    !raw.orders.every(isRecord) ||
    !nonNegativeInteger(raw.order_count) ||
    typeof raw.truncated !== "boolean"
  ) {
    return null;
  }
  return Object.freeze({
    format_version: 1,
    exported_at: raw.exported_at,
    customer: Object.freeze({
      customer_id: raw.customer.customer_id,
      phone: raw.customer.phone,
      name: raw.customer.name,
      note: raw.customer.note,
      created_at: raw.customer.created_at,
      updated_at: raw.customer.updated_at,
    }),
    orders: Object.freeze(raw.orders.map((order) => Object.freeze({ ...order }))),
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
