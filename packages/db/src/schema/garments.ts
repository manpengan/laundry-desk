import {
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { orderLines } from "./order-lines.js";
import { orders } from "./orders.js";

/**
 * Physical garment unit (M2 skeleton) — one row per piece, no qty.
 * FKs include order_id so a garment cannot attach to another order's line.
 */
export const garments = pgTable(
  "garments",
  {
    id: uuid("id").notNull(),
    orgId: uuid("org_id").notNull(),
    storeId: uuid("store_id").notNull(),
    orderId: uuid("order_id").notNull(),
    orderLineId: uuid("order_line_id").notNull(),
    seq: integer("seq").notNull(),
    barcode: text("barcode").notNull(),
    serviceCode: text("service_code").notNull(),
    categoryCode: text("category_code").notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(),
    color: text("color"),
    brand: text("brand"),
    status: text("status").notNull().default("received"),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: "garments_pkey" }),
    uniqueIndex("garments_tenant_id_uidx").on(table.orgId, table.storeId, table.id),
    uniqueIndex("garments_order_garment_uidx").on(
      table.orgId,
      table.storeId,
      table.orderId,
      table.id,
    ),
    uniqueIndex("garments_barcode_uidx").on(table.orgId, table.storeId, table.barcode),
    uniqueIndex("garments_line_seq_uidx").on(
      table.orgId,
      table.storeId,
      table.orderId,
      table.orderLineId,
      table.seq,
    ),
    index("garments_order_idx").on(table.orgId, table.storeId, table.orderId),
    index("garments_store_status_idx").on(table.orgId, table.storeId, table.status),
    foreignKey({
      columns: [table.orgId, table.storeId, table.orderId],
      foreignColumns: [orders.orgId, orders.storeId, orders.id],
      name: "garments_order_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.storeId, table.orderId, table.orderLineId],
      foreignColumns: [orderLines.orgId, orderLines.storeId, orderLines.orderId, orderLines.id],
      name: "garments_order_line_fk",
    }),
  ],
);
