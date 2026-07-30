export type CustomerRowView = Readonly<{
  customer_id: string;
  phone: string;
  name: string | null;
  note: string | null;
  updated_at: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function unwrapQueryResult(data: unknown): unknown {
  if (!isRecord(data)) return data;
  return "result" in data ? data.result : data;
}

export function parseCustomerRows(value: unknown): readonly CustomerRowView[] | null {
  if (!isRecord(value) || !Array.isArray(value.customers)) return null;
  const rows: CustomerRowView[] = [];
  for (const item of value.customers) {
    if (
      !isRecord(item) ||
      typeof item.customer_id !== "string" ||
      typeof item.phone_masked !== "string" ||
      typeof item.updated_at !== "number" ||
      !Number.isSafeInteger(item.updated_at)
    ) {
      return null;
    }
    const name = item.name === null || item.name === undefined ? null : String(item.name);
    rows.push(
      Object.freeze({
        customer_id: item.customer_id,
        phone: item.phone_masked,
        name,
        note: null,
        updated_at: item.updated_at,
      }),
    );
  }
  return Object.freeze(rows);
}

export function parseCustomerDetail(value: unknown): CustomerRowView | null {
  if (
    !isRecord(value) ||
    typeof value.customer_id !== "string" ||
    typeof value.phone !== "string" ||
    typeof value.updated_at !== "number" ||
    !Number.isSafeInteger(value.updated_at)
  ) {
    return null;
  }
  return Object.freeze({
    customer_id: value.customer_id,
    phone: value.phone,
    name: value.name === null || value.name === undefined ? null : String(value.name),
    note: value.note === null || value.note === undefined ? null : String(value.note),
    updated_at: value.updated_at,
  });
}

export function formatCustomerUpdatedAt(epochSec: number): string {
  const date = new Date(epochSec * 1_000);
  if (Number.isNaN(date.getTime())) return "—";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}
