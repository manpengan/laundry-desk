export type FulfillmentStatus =
  "received" | "washing" | "ready" | "racked" | "picked_up" | "delivered" | "reworked" | "lost";

export type FulfillmentRowView = Readonly<{
  garment_id: string;
  order_id: string;
  ticket_no: string;
  barcode: string;
  customer_name: string | null;
  customer_phone_masked: string | null;
  service_code: string;
  category_code: string;
  color: string | null;
  brand: string | null;
  status: FulfillmentStatus;
  updated_at: number;
  incident_count: number;
}>;

const STATUSES = new Set<FulfillmentStatus>([
  "received",
  "washing",
  "ready",
  "racked",
  "picked_up",
  "delivered",
  "reworked",
  "lost",
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function unwrapFulfillmentResult(value: unknown): unknown {
  return isRecord(value) && "result" in value ? value.result : value;
}

export function parseFulfillmentRows(value: unknown): readonly FulfillmentRowView[] | null {
  if (!isRecord(value) || !Array.isArray(value.garments)) return null;
  const rows: FulfillmentRowView[] = [];
  for (const item of value.garments) {
    if (
      !isRecord(item) ||
      typeof item.garment_id !== "string" ||
      typeof item.order_id !== "string" ||
      typeof item.ticket_no !== "string" ||
      typeof item.barcode !== "string" ||
      typeof item.service_code !== "string" ||
      typeof item.category_code !== "string" ||
      typeof item.status !== "string" ||
      !STATUSES.has(item.status as FulfillmentStatus) ||
      typeof item.updated_at !== "number" ||
      !Number.isSafeInteger(item.updated_at) ||
      typeof item.incident_count !== "number" ||
      !Number.isSafeInteger(item.incident_count)
    ) {
      return null;
    }
    const nullableString = (field: unknown): string | null =>
      field === null || field === undefined ? null : String(field);
    rows.push(
      Object.freeze({
        garment_id: item.garment_id,
        order_id: item.order_id,
        ticket_no: item.ticket_no,
        barcode: item.barcode,
        customer_name: nullableString(item.customer_name),
        customer_phone_masked: nullableString(item.customer_phone_masked),
        service_code: item.service_code,
        category_code: item.category_code,
        color: nullableString(item.color),
        brand: nullableString(item.brand),
        status: item.status as FulfillmentStatus,
        updated_at: item.updated_at,
        incident_count: item.incident_count,
      }),
    );
  }
  return Object.freeze(rows);
}

export const FULFILLMENT_STATUS_LABELS: Readonly<Record<FulfillmentStatus, string>> = Object.freeze(
  {
    received: "已收",
    washing: "加工中",
    ready: "已完成",
    racked: "待取",
    picked_up: "已取",
    delivered: "已送达",
    reworked: "返工",
    lost: "丢损",
  },
);

export function transitionCommandForCount(
  count: number,
): "garment.transition" | "garment.bulk_transition" {
  return count === 1 ? "garment.transition" : "garment.bulk_transition";
}
