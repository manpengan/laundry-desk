import {
  boolean,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  index,
} from "drizzle-orm/pg-core";

import { stores } from "./stores.js";

/**
 * Store-scope catalog price rows (M2).
 * Maps to domain CatalogItem; money is integer cents.
 */
export const catalogItems = pgTable(
  "catalog_items",
  {
    id: uuid("id").notNull(),
    orgId: uuid("org_id").notNull(),
    storeId: uuid("store_id").notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    serviceCode: text("service_code").notNull(),
    categoryCode: text("category_code").notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(),
    mnemonic: text("mnemonic"),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: "catalog_items_pkey" }),
    uniqueIndex("catalog_items_tenant_id_uidx").on(table.orgId, table.storeId, table.id),
    uniqueIndex("catalog_items_code_uidx").on(table.orgId, table.storeId, table.code),
    index("catalog_items_store_active_sort_idx").on(
      table.orgId,
      table.storeId,
      table.isActive,
      table.sortOrder,
    ),
    foreignKey({
      columns: [table.orgId, table.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: "catalog_items_store_fk",
    }),
  ],
);
