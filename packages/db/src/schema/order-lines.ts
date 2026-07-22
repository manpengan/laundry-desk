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

import { orders } from "./orders.js";

/**
 * Pricing lines for an order (M2 skeleton).
 * Unique key layout: (org_id, store_id, order_id, id) per contracts tenant FKs.
 */
export const orderLines = pgTable(
  "order_lines",
  {
    id: uuid("id").notNull(),
    orgId: uuid("org_id").notNull(),
    storeId: uuid("store_id").notNull(),
    orderId: uuid("order_id").notNull(),
    lineIndex: integer("line_index").notNull(),
    serviceCode: text("service_code").notNull(),
    categoryCode: text("category_code").notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(),
    qty: integer("qty").notNull(),
    lineTotalCents: integer("line_total_cents").notNull(),
    color: text("color"),
    brand: text("brand"),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: "order_lines_pkey" }),
    uniqueIndex("order_lines_tenant_id_uidx").on(
      table.orgId,
      table.storeId,
      table.orderId,
      table.id,
    ),
    uniqueIndex("order_lines_line_index_uidx").on(
      table.orgId,
      table.storeId,
      table.orderId,
      table.lineIndex,
    ),
    index("order_lines_order_idx").on(table.orgId, table.storeId, table.orderId),
    foreignKey({
      columns: [table.orgId, table.storeId, table.orderId],
      foreignColumns: [orders.orgId, orders.storeId, orders.id],
      name: "order_lines_order_fk",
    }),
  ],
);
