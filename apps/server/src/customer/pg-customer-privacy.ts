import type { SqlClient } from "../db/types.js";
import type {
  CustomerAnonymizeResult,
  CustomerPrivacyActionInput,
  CustomerPrivacyEvent,
  CustomerPrivacyExport,
  CustomerPrivacyStatus,
} from "./types.js";

function boundedInteger(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("customer privacy count is invalid");
  }
  return parsed;
}

function epoch(value: Date | string | null): number | null {
  if (value === null) return null;
  const millis = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error("customer privacy timestamp is invalid");
  return Math.floor(millis / 1000);
}

export async function readPgPrivacyStatus(
  client: SqlClient,
  customerId: string,
): Promise<CustomerPrivacyStatus | null> {
  const result = await client.query<
    Readonly<{
      active_order_count: string;
      retained_order_count: string;
      photo_count: string;
      latest_order_at: Date | string | null;
    }>
  >("SELECT * FROM customer_privacy_status($1::uuid)", [customerId]);
  const row = result.rows[0];
  if (row === undefined) return null;
  const activeOrderCount = boundedInteger(row.active_order_count);
  return Object.freeze({
    customer_id: customerId,
    active_order_count: activeOrderCount,
    retained_order_count: boundedInteger(row.retained_order_count),
    photo_count: boundedInteger(row.photo_count),
    latest_order_at: epoch(row.latest_order_at),
    anonymization_eligible: activeOrderCount === 0,
  });
}

export async function readPgPrivacyEvents(
  client: SqlClient,
  orgId: string,
  customerId: string,
  limit: number,
): Promise<readonly CustomerPrivacyEvent[]> {
  const result = await client.query<
    Readonly<{
      id: string;
      customer_id: string;
      action: "exported" | "anonymized";
      reason: string;
      affected_order_count: number;
      created_at: Date | string;
    }>
  >(
    `SELECT id::text, customer_id::text, action, reason, affected_order_count, created_at
       FROM customer_privacy_events
      WHERE org_id = $1::uuid AND customer_id = $2::uuid
      ORDER BY created_at DESC, id DESC
      LIMIT $3`,
    [orgId, customerId, Math.min(limit, 50)],
  );
  return Object.freeze(
    result.rows.map((row) =>
      Object.freeze({
        event_id: row.id,
        customer_id: row.customer_id,
        action: row.action,
        reason: row.reason,
        affected_order_count: boundedInteger(row.affected_order_count),
        created_at: epoch(row.created_at)!,
      }),
    ),
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseExport(value: unknown): CustomerPrivacyExport | null {
  if (!isRecord(value) || value.format_version !== 1 || !isRecord(value.customer)) return null;
  const customer = value.customer;
  if (
    typeof value.exported_at !== "number" ||
    typeof customer.customer_id !== "string" ||
    typeof customer.phone !== "string" ||
    !Array.isArray(value.orders) ||
    typeof value.order_count !== "number" ||
    typeof value.truncated !== "boolean"
  ) {
    throw new Error("customer privacy export is invalid");
  }
  return Object.freeze({
    format_version: 1,
    exported_at: value.exported_at,
    customer: Object.freeze({
      customer_id: customer.customer_id,
      phone: customer.phone,
      name: typeof customer.name === "string" ? customer.name : null,
      note: typeof customer.note === "string" ? customer.note : null,
      created_at: boundedInteger(customer.created_at),
      updated_at: boundedInteger(customer.updated_at),
    }),
    orders: Object.freeze(
      value.orders.map((order) => {
        if (!isRecord(order)) throw new Error("customer privacy export order is invalid");
        return Object.freeze({ ...order });
      }),
    ),
    order_count: boundedInteger(value.order_count),
    truncated: value.truncated,
  });
}

export async function exportPgPrivacy(
  client: SqlClient,
  input: CustomerPrivacyActionInput,
): Promise<CustomerPrivacyExport | null> {
  const result = await client.query<Readonly<{ payload: unknown }>>(
    `SELECT customer_privacy_export($1::uuid, $2, $3::uuid, $4) AS payload`,
    [input.customer_id, input.reason, input.event_id, new Date(input.now * 1000)],
  );
  return parseExport(result.rows[0]?.payload);
}

export async function anonymizePgCustomer(
  client: SqlClient,
  input: CustomerPrivacyActionInput,
): Promise<CustomerAnonymizeResult | null> {
  const result = await client.query<
    Readonly<{
      anonymized: boolean;
      affected_order_count: number;
      blocked_active_order_count: number;
    }>
  >("SELECT * FROM customer_privacy_anonymize($1::uuid, $2, $3::uuid, $4)", [
    input.customer_id,
    input.reason,
    input.event_id,
    new Date(input.now * 1000),
  ]);
  const row = result.rows[0];
  if (row === undefined || row.anonymized !== true) return null;
  return Object.freeze({
    customer_id: input.customer_id,
    affected_order_count: boundedInteger(row.affected_order_count),
  });
}
