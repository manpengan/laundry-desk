import { z } from "zod";
import { v1HistorySchema } from "./history.js";
import type { V1Snapshot } from "./types.js";

const integer = z.number().int().safe();
const id = integer.positive();
const money = integer.nonnegative().max(2_147_483_647);
const epoch = integer.nonnegative().max(253_402_300_799).nullable();
const text = z.string().max(65_536);
const rows = <T extends z.ZodType>(schema: T) => z.array(schema).max(100_000);

/** Bound untrusted loader input independently of the SQLite extractor. */
export const v1SnapshotSchema: z.ZodType<V1Snapshot> = z
  .object({
    history: v1HistorySchema.optional(),
    sourceBackupSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    customers: rows(
      z
        .object({
          id,
          name: text.min(1),
          phone: text.min(1),
          vipLevel: integer.nonnegative(),
          totalOrders: integer.nonnegative(),
          totalSpentCents: money,
          createdAt: epoch,
          updatedAt: epoch,
        })
        .strict(),
    ),
    orders: rows(
      z
        .object({
          id,
          orderNo: text.min(1),
          pickupCode: text.min(1),
          customerId: id,
          status: z.enum(["pending", "ready", "picked_up", "cancelled"]),
          totalCents: money,
          paidCents: money,
          paymentMethod: z.enum(["cash", "wechat", "alipay", "card", "unpaid"]),
          receiveAt: epoch,
          expectedPickupAt: epoch,
          actualPickupAt: epoch,
          staffId: id.nullable(),
          pickedUpBy: id.nullable(),
          note: text.nullable(),
          createdAt: epoch,
          updatedAt: epoch,
        })
        .strict(),
    ),
    orderItems: rows(
      z
        .object({
          id,
          orderId: id,
          itemType: text.min(1),
          serviceType: z.enum(["wash", "dry_clean", "iron"]),
          quantity: id.max(100_000),
          unitPriceCents: money,
          subtotalCents: money,
          itemNotes: text.nullable(),
        })
        .strict(),
    ),
    orderPhotos: rows(
      z.object({ id, orderId: id, filePath: text.min(1), takenAt: epoch }).strict(),
    ),
    settings: rows(z.object({ key: text.min(1), value: text, updatedAt: epoch }).strict()),
  })
  .strict();

function unique(values: readonly (string | number)[]): void {
  if (new Set(values).size !== values.length) throw new Error("V1_MIGRATION_DUPLICATE_SOURCE_KEY");
}

function assertRelations(snapshot: V1Snapshot): void {
  if (snapshot.history) {
    for (const rows of [snapshot.history.staffs, snapshot.history.sms, snapshot.history.audit])
      unique(rows.map((row) => row.id));
    if (snapshot.history.excluded_credential_count !== snapshot.history.staffs.length)
      throw new Error("V1_MIGRATION_HISTORY_COUNT_MISMATCH");
  }
  unique(snapshot.customers.map((row) => row.id));
  unique(snapshot.customers.map((row) => row.phone));
  unique(snapshot.orders.map((row) => row.id));
  unique(snapshot.orders.map((row) => row.orderNo));
  unique(snapshot.orderItems.map((row) => row.id));
  unique(snapshot.orderPhotos.map((row) => row.id));
  unique(snapshot.settings.map((row) => row.key));
  const orders = new Set(snapshot.orders.map((row) => row.id));
  if (snapshot.orderItems.some((row) => !orders.has(row.orderId))) {
    throw new Error("V1_MIGRATION_ORPHAN_ITEM");
  }
  if (snapshot.orderItems.reduce((count, row) => count + row.quantity, 0) > 100_000) {
    throw new Error("V1_MIGRATION_GARMENT_LIMIT");
  }
}

export function validateMigrationSource(input: unknown): V1Snapshot {
  const snapshot = v1SnapshotSchema.parse(input);
  assertRelations(snapshot);
  return snapshot;
}
