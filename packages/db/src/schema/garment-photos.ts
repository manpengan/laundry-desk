import {
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { staffs } from "./staffs.js";
import { stores } from "./stores.js";
import { garments } from "./garments.js";

/**
 * Store-scope garment photo metadata (M3 skeleton).
 * storage_key is opaque (client upload target later); no blob columns.
 * Composite garment/order FK prevents cross-order and cross-tenant photo links.
 * laundry_app is granted SELECT, INSERT only — no UPDATE/DELETE.
 */
export const garmentPhotos = pgTable(
  "garment_photos",
  {
    id: uuid("id").notNull(),
    orgId: uuid("org_id").notNull(),
    storeId: uuid("store_id").notNull(),
    garmentId: uuid("garment_id").notNull(),
    orderId: uuid("order_id").notNull(),
    kind: text("kind").notNull(),
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull().default("image/jpeg"),
    byteSize: integer("byte_size").notNull(),
    takenAt: timestamp("taken_at", { withTimezone: true, mode: "date" }).notNull(),
    createdByStaffId: uuid("created_by_staff_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: "garment_photos_pkey" }),
    uniqueIndex("garment_photos_tenant_id_uidx").on(table.orgId, table.storeId, table.id),
    index("garment_photos_order_idx").on(table.orgId, table.storeId, table.orderId, table.takenAt),
    index("garment_photos_garment_idx").on(
      table.orgId,
      table.storeId,
      table.garmentId,
      table.takenAt,
    ),
    foreignKey({
      columns: [table.orgId, table.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: "garment_photos_store_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.createdByStaffId],
      foreignColumns: [staffs.orgId, staffs.id],
      name: "garment_photos_staff_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.storeId, table.orderId, table.garmentId],
      foreignColumns: [garments.orgId, garments.storeId, garments.orderId, garments.id],
      name: "garment_photos_garment_order_fk",
    }),
  ],
);
