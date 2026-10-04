import { canonicalMigrationJson, type V2MigrationPlan } from "@laundry/migrate-v1/plan";
import type { SqlClient, TenantContext } from "../db/types.js";
import type { StoredPhoto } from "../photo/file-store.js";
import { legacyGarmentNote, legacyRecords } from "./import-legacy.js";
import { migrationPickupCodes } from "./import-pickup.js";

export type ImportRow = Readonly<Record<string, unknown>>;
type TableSpec = Readonly<{ table: string; columns: readonly string[] }>;
const spec = (table: string, columns: string): TableSpec =>
  Object.freeze({
    table,
    columns: Object.freeze(columns.split(" ")),
  });
/** Identifiers are compile-time constants, never derived from source JSON. */
export const IMPORT_TABLES = Object.freeze({
  customers: spec("customers", "id org_id phone name created_at updated_at"),
  orders: spec(
    "orders",
    "id org_id store_id ticket_no pickup_code status customer_id customer_phone customer_name note subtotal_cents original_cents payable_cents paid_cents balance_cents business_date created_at updated_at created_by_staff_id",
  ),
  order_lines: spec(
    "order_lines",
    "id org_id store_id order_id line_index service_code category_code unit_price_cents qty line_total_cents garment_details_json",
  ),
  garments: spec(
    "garments",
    "id org_id store_id order_id order_line_id seq barcode service_code category_code unit_price_cents status note",
  ),
  payments: spec(
    "payments",
    "id org_id store_id order_id method amount_cents kind staff_id at business_date",
  ),
  garment_photos: spec(
    "garment_photos",
    "id org_id store_id garment_id order_id kind storage_key content_type content_sha256 byte_size taken_at created_by_staff_id",
  ),
  v1_import_legacy_records: spec(
    "v1_import_legacy_records",
    "id org_id store_id batch_id entity_type entity_id customer_id metadata",
  ),
});
export type ImportTable = keyof typeof IMPORT_TABLES;
export type ImportRows = Readonly<Record<ImportTable, readonly ImportRow[]>>;
const iso = (epoch: number) => new Date(epoch * 1000).toISOString();
function businessDate(epoch: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(epoch * 1000);
  const part = (type: string) => parts.find((value) => value.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function buildImportRows(
  plan: V2MigrationPlan,
  tenant: TenantContext,
  timezone: string,
  batchId: string,
  photos: ReadonlyMap<string, StoredPhoto>,
): ImportRows {
  const scope = { org_id: tenant.orgId, store_id: tenant.storeId };
  const pickupCodes = migrationPickupCodes(plan);
  return Object.freeze({
    customers: plan.customers.map((row) => ({
      id: row.id,
      org_id: tenant.orgId,
      phone: row.phone,
      name: row.name,
      created_at: iso(row.createdAt),
      updated_at: iso(row.updatedAt),
    })),
    orders: plan.orders.map((row) => ({
      ...scope,
      id: row.id,
      ticket_no: row.ticketNo,
      pickup_code: pickupCodes.get(row.id),
      status: row.status,
      customer_id: row.customerId,
      customer_phone: row.customerPhone,
      customer_name: row.customerName,
      note: row.note,
      subtotal_cents: row.subtotalCents,
      original_cents: row.subtotalCents,
      payable_cents: row.payableCents,
      paid_cents: row.paidCents,
      balance_cents: row.balanceCents,
      business_date: businessDate(row.createdAt, timezone),
      created_at: iso(row.createdAt),
      updated_at: iso(row.updatedAt),
      created_by_staff_id: tenant.staffId,
    })),
    order_lines: plan.orders.flatMap((order) =>
      order.lines.map((row) => ({
        ...scope,
        id: row.id,
        order_id: order.id,
        line_index: row.lineIndex,
        service_code: row.serviceCode,
        category_code: row.categoryCode,
        unit_price_cents: row.unitPriceCents,
        qty: row.qty,
        line_total_cents: row.lineTotalCents,
        garment_details_json: Array.from({ length: row.qty }, () => ({
          color: null,
          brand: null,
          defects: [],
          accessories: [],
          note: legacyGarmentNote(row),
          addons: [],
        })),
      })),
    ),
    garments: plan.orders.flatMap((order) =>
      order.garments.map((row) => ({
        ...scope,
        id: row.id,
        order_id: order.id,
        order_line_id: row.orderLineId,
        seq: row.seq,
        barcode: row.barcode,
        service_code: row.serviceCode,
        category_code: row.categoryCode,
        unit_price_cents: row.unitPriceCents,
        status: row.status,
        note: legacyGarmentNote(order.lines.find((line) => line.id === row.orderLineId)!),
      })),
    ),
    payments: plan.orders.flatMap((order) =>
      order.payment === null
        ? []
        : [
            {
              ...scope,
              id: order.payment.id,
              order_id: order.id,
              method: order.payment.method,
              amount_cents: order.payment.amountCents,
              kind: "pay",
              staff_id: tenant.staffId,
              at: iso(order.payment.at),
              business_date: businessDate(order.payment.at, timezone),
            },
          ],
    ),
    garment_photos: plan.photos.map((row) => {
      const stored = photos.get(row.id);
      if (stored === undefined) throw new Error("V1_MIGRATION_PHOTO_MISSING");
      return {
        ...scope,
        ...stored,
        id: row.id,
        garment_id: row.garmentId,
        order_id: row.orderId,
        kind: "other",
        taken_at: iso(row.takenAt),
        created_by_staff_id: tenant.staffId,
      };
    }),
    v1_import_legacy_records: legacyRecords(plan, batchId).map((row) => ({ ...scope, ...row })),
  });
}

export async function writeImportRows(client: SqlClient, rows: ImportRows): Promise<void> {
  for (const table of Object.keys(IMPORT_TABLES) as ImportTable[]) {
    const { columns } = IMPORT_TABLES[table];
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
    const sql = `INSERT INTO public.${table} (${columns.join(", ")}) VALUES (${placeholders})`;
    for (const row of rows[table]) {
      await client.query(
        sql,
        columns.map((column) =>
          column === "garment_details_json" ? JSON.stringify(row[column]) : row[column],
        ),
      );
    }
  }
}

/** Read every inserted field through the same app-role transaction before COMMIT. */
export async function verifyImportRows(client: SqlClient, rows: ImportRows): Promise<void> {
  for (const table of Object.keys(IMPORT_TABLES) as ImportTable[]) {
    const { columns } = IMPORT_TABLES[table];
    const expected = rows[table];
    const result = await client.query<ImportRow>(
      `SELECT ${columns.join(", ")} FROM public.${table} WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [expected.map((row) => row.id)],
    );
    const normalize = (row: ImportRow) =>
      Object.fromEntries(
        columns.map((column) => {
          const value = row[column];
          return [column, value instanceof Date ? value.toISOString() : value];
        }),
      );
    const expectedSorted = [...expected].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    if (
      canonicalMigrationJson(result.rows.map(normalize)) !==
      canonicalMigrationJson(expectedSorted.map(normalize))
    ) {
      throw new Error("V1_MIGRATION_DATABASE_RECONCILIATION_FAILED");
    }
  }
}
