import { createHash } from "node:crypto";
import { z } from "zod";
import type { V2MigrationPlan } from "@laundry/migrate-v1/plan";
import { legacyHistoryRecords } from "./import-history.js";

export function migrationId(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const priceTemplates = z
  .array(
    z
      .object({
        itemType: z.string().min(1).max(128),
        serviceType: z.enum(["wash", "dry_clean", "iron"]),
        price: z.number().int().nonnegative().max(2_147_483_647),
      })
      .strict(),
  )
  .max(1000);

/** Do not activate arbitrary legacy settings in the current service. */
export function assertSupportedLegacySettings(plan: V2MigrationPlan): void {
  for (const order of plan.orders) for (const line of order.lines) legacyGarmentNote(line);
  for (const setting of plan.sourceSnapshot.settings) {
    if (setting.key === "shop.name") z.string().min(1).max(128).parse(setting.value);
    else if (setting.key === "price_templates") priceTemplates.parse(JSON.parse(setting.value));
    else throw new Error("V1_MIGRATION_SETTING_MAPPING_REQUIRED");
  }
}

/** Keep the original display name and instructions visible in existing garment
 * details. Reject values outside that UI contract instead of truncating them. */
export function legacyGarmentNote(
  line: Readonly<{ legacyItemType: string; legacyItemNotes: string | null }>,
): string {
  const note = `旧版衣物：${line.legacyItemType}${line.legacyItemNotes === null ? "" : `\n${line.legacyItemNotes}`}`;
  if (note.length > 256) throw new Error("V1_MIGRATION_GARMENT_DISPLAY_MAPPING_REQUIRED");
  return note;
}

export type LegacyRecord = Readonly<{
  id: string;
  batch_id: string;
  entity_type: string;
  entity_id: string;
  customer_id: string | null;
  metadata: Readonly<Record<string, unknown>>;
}>;

/** Only unmapped, typed source fields are retained; no duplicate names/phones. */
export function legacyRecords(plan: V2MigrationPlan, batchId: string): readonly LegacyRecord[] {
  const source = plan.sourceSnapshot;
  const record = (
    type: string,
    entityId: string,
    customerId: string | null,
    metadata: Readonly<Record<string, unknown>>,
  ): LegacyRecord =>
    Object.freeze({
      id: migrationId(`${batchId}:${type}:${entityId}`),
      batch_id: batchId,
      entity_type: type,
      entity_id: entityId,
      customer_id: customerId,
      metadata,
    });
  return Object.freeze([
    ...legacyHistoryRecords(plan, batchId, migrationId),
    ...plan.customers.map((row, index) => {
      const original = source.customers[index]!;
      return record("customer", row.id, row.id, {
        legacy_id: original.id,
        vip_level: original.vipLevel,
        total_orders: original.totalOrders,
        total_spent_cents: original.totalSpentCents,
        created_at: original.createdAt,
        updated_at: original.updatedAt,
      });
    }),
    ...plan.orders.flatMap((row, index) => {
      const original = source.orders[index]!;
      return [
        record("order", row.id, row.customerId, {
          legacy_id: original.id,
          pickup_code: original.pickupCode,
          receive_at: original.receiveAt,
          expected_pickup_at: original.expectedPickupAt,
          actual_pickup_at: original.actualPickupAt,
          staff_id: original.staffId,
          picked_up_by: original.pickedUpBy,
          created_at: original.createdAt,
          updated_at: original.updatedAt,
          status: original.status,
          payment_method: original.paymentMethod,
        }),
        ...row.lines.map((line) =>
          record("line", line.id, row.customerId, {
            legacy_id: line.legacyOrderItemId,
            item_type: line.legacyItemType,
            item_notes: line.legacyItemNotes,
          }),
        ),
      ];
    }),
    ...plan.photos.map((row, index) => {
      const customerId = plan.orders.find((order) => order.id === row.orderId)!.customerId;
      return record("photo", row.id, customerId, {
        legacy_id: row.legacyPhotoId,
        file_path: source.orderPhotos[index]!.filePath,
        taken_at: source.orderPhotos[index]!.takenAt,
        association: "first_garment_in_legacy_order",
        garment_id: row.garmentId,
      });
    }),
    ...plan.settings.map((row, index) =>
      record("setting", row.id, null, {
        key: row.key,
        value: source.settings[index]!.value,
        updated_at: source.settings[index]!.updatedAt,
      }),
    ),
  ]);
}
