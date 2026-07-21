import {
  boolean,
  foreignKey,
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { stores } from "./stores.js";

/**
 * Store-scope feature flags (A3 matrix: store).
 * Architecture §3.3: fulfillment / membership / shift_closing / delivery / marketing / ai.
 */
export const storeFeatures = pgTable(
  "store_features",
  {
    id: uuid("id").notNull(),
    orgId: uuid("org_id").notNull(),
    storeId: uuid("store_id").notNull(),
    fulfillment: boolean("fulfillment").notNull().default(false),
    membership: boolean("membership").notNull().default(false),
    shiftClosing: boolean("shift_closing").notNull().default(false),
    delivery: boolean("delivery").notNull().default(false),
    marketing: boolean("marketing").notNull().default(false),
    ai: boolean("ai").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: "store_features_pkey" }),
    uniqueIndex("store_features_tenant_id_uidx").on(table.orgId, table.storeId, table.id),
    uniqueIndex("store_features_store_uidx").on(table.orgId, table.storeId),
    foreignKey({
      columns: [table.orgId, table.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: "store_features_store_fk",
    }),
  ],
);
