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
  const rootResult = await client.query<Readonly<{ root_id: string | null }>>(
    "SELECT customer_canonical_root($1::uuid)::text AS root_id",
    [customerId],
  );
  const rootId = rootResult.rows[0]?.root_id;
  if (rootId == null) return null;
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
    customer_id: rootId,
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
      WHERE org_id = $1::uuid
        AND customer_id IN (
          SELECT group_customer_id FROM customer_canonical_group($2::uuid)
        )
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

function assertBoundedRows(
  label: string,
  rows: readonly unknown[],
  count: number,
  truncated: unknown,
): asserts truncated is boolean {
  if (
    rows.length > 1000 ||
    count < rows.length ||
    typeof truncated !== "boolean" ||
    truncated !== count > rows.length
  ) {
    throw new Error(`customer privacy export ${label} bounds are invalid`);
  }
}

function parseExport(value: unknown): CustomerPrivacyExport | null {
  if (!isRecord(value) || value.format_version !== 2 || !isRecord(value.customer)) return null;
  const customer = value.customer;
  if (
    typeof value.exported_at !== "number" ||
    typeof customer.customer_id !== "string" ||
    typeof customer.phone !== "string" ||
    !Array.isArray(value.canonical_customers) ||
    !Array.isArray(value.profiles) ||
    !Array.isArray(value.addresses) ||
    !Array.isArray(value.identifiers) ||
    !Array.isArray(value.related_narratives) ||
    !Array.isArray(value.notification_deliveries) ||
    !Array.isArray(value.factory_handoff_evidence) ||
    !Array.isArray(value.orders) ||
    value.delivery_evidence_retention !== "retained_operational_evidence" ||
    value.delivery_unlinked_upload_cleanup !==
      "private_file_purged_after_expiry_metadata_retained" ||
    typeof value.order_count !== "number" ||
    typeof value.truncated !== "boolean"
  ) {
    throw new Error("customer privacy export is invalid");
  }
  const records = (rows: readonly unknown[], label: string) =>
    Object.freeze(
      rows.map((row) => {
        if (!isRecord(row)) throw new Error(`customer privacy export ${label} is invalid`);
        return Object.freeze({ ...row });
      }),
    );
  const canonicalCustomers = value.canonical_customers.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.customer_id !== "string" ||
      typeof entry.phone !== "string"
    ) {
      throw new Error("customer privacy export canonical customer is invalid");
    }
    return Object.freeze({
      customer_id: entry.customer_id,
      phone: entry.phone,
      name: typeof entry.name === "string" ? entry.name : null,
      note: typeof entry.note === "string" ? entry.note : null,
      merged_into_id: typeof entry.merged_into_id === "string" ? entry.merged_into_id : null,
      created_at: boundedInteger(entry.created_at),
      updated_at: boundedInteger(entry.updated_at),
    });
  });
  const profile = value.profile === null ? null : (records([value.profile], "profile")[0] ?? null);
  const profiles = records(value.profiles, "profile");
  const profileCount = boundedInteger(value.profile_count);
  const addressCount = boundedInteger(value.address_count);
  const identifierCount = boundedInteger(value.identifier_count);
  const relatedNarrativeCount = boundedInteger(value.related_narrative_count);
  const notificationDeliveryCount = boundedInteger(value.notification_delivery_count);
  const factoryHandoffEvidenceCount = boundedInteger(value.factory_handoff_evidence_count);
  const deliveryEvidenceCount = boundedInteger(value.delivery_evidence_count);
  const deliveryAttachmentCount = boundedInteger(value.delivery_attachment_count);
  const orderCount = boundedInteger(value.order_count);
  const canonicalCustomerCount = boundedInteger(value.canonical_customer_count);
  assertBoundedRows("profile", profiles, profileCount, value.profiles_truncated);
  assertBoundedRows("address", value.addresses, addressCount, value.addresses_truncated);
  assertBoundedRows("identifier", value.identifiers, identifierCount, value.identifiers_truncated);
  assertBoundedRows(
    "related narrative",
    value.related_narratives,
    relatedNarrativeCount,
    value.related_narratives_truncated,
  );
  assertBoundedRows(
    "notification delivery",
    value.notification_deliveries,
    notificationDeliveryCount,
    value.notification_deliveries_truncated,
  );
  assertBoundedRows(
    "factory handoff evidence",
    value.factory_handoff_evidence,
    factoryHandoffEvidenceCount,
    value.factory_handoff_evidence_truncated,
  );
  assertBoundedRows("order", value.orders, orderCount, value.truncated);
  if (
    canonicalCustomerCount !== canonicalCustomers.length ||
    (profile === null) !== (profiles.length === 0)
  ) {
    throw new Error("customer privacy export canonical bounds are invalid");
  }
  return Object.freeze({
    format_version: 2,
    exported_at: value.exported_at,
    customer: Object.freeze({
      customer_id: customer.customer_id,
      phone: customer.phone,
      name: typeof customer.name === "string" ? customer.name : null,
      note: typeof customer.note === "string" ? customer.note : null,
      created_at: boundedInteger(customer.created_at),
      updated_at: boundedInteger(customer.updated_at),
    }),
    canonical_customers: Object.freeze(canonicalCustomers),
    canonical_customer_count: canonicalCustomerCount,
    profile,
    profiles,
    profile_count: profileCount,
    profiles_truncated: value.profiles_truncated,
    addresses: records(value.addresses, "address"),
    address_count: addressCount,
    addresses_truncated: value.addresses_truncated,
    retired_address_count: boundedInteger(value.retired_address_count),
    identifiers: records(value.identifiers, "identifier"),
    identifier_count: identifierCount,
    identifiers_truncated: value.identifiers_truncated,
    retired_identifier_count: boundedInteger(value.retired_identifier_count),
    related_narratives: records(value.related_narratives, "related narrative"),
    related_narrative_count: relatedNarrativeCount,
    related_narratives_truncated: value.related_narratives_truncated,
    retained_garment_photo_count: boundedInteger(value.retained_garment_photo_count),
    notification_deliveries: records(value.notification_deliveries, "notification delivery"),
    notification_delivery_count: notificationDeliveryCount,
    notification_deliveries_truncated: value.notification_deliveries_truncated,
    factory_handoff_evidence: records(value.factory_handoff_evidence, "factory handoff evidence"),
    factory_handoff_evidence_count: factoryHandoffEvidenceCount,
    factory_handoff_evidence_truncated: value.factory_handoff_evidence_truncated,
    delivery_evidence_count: deliveryEvidenceCount,
    delivery_attachment_count: deliveryAttachmentCount,
    delivery_evidence_retention: "retained_operational_evidence",
    delivery_unlinked_upload_cleanup: "private_file_purged_after_expiry_metadata_retained",
    orders: Object.freeze(
      value.orders.map((order) => {
        if (!isRecord(order)) throw new Error("customer privacy export order is invalid");
        return Object.freeze({ ...order });
      }),
    ),
    order_count: orderCount,
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
  const rootResult = await client.query<Readonly<{ root_id: string | null }>>(
    "SELECT customer_canonical_root($1::uuid)::text AS root_id",
    [input.customer_id],
  );
  const rootId = rootResult.rows[0]?.root_id;
  if (rootId == null) return null;
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
    customer_id: rootId,
    affected_order_count: boundedInteger(row.affected_order_count),
  });
}
