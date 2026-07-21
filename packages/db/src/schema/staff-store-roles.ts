import {
  boolean,
  foreignKey,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { staffs } from "./staffs.js";
import { stores } from "./stores.js";

/**
 * Store-scope staff role assignment (A3 matrix: store).
 * Tenant FKs use (org_id, store_id) / (org_id, staff_id) composite layouts.
 */
export const staffStoreRoles = pgTable(
  "staff_store_roles",
  {
    id: uuid("id").notNull(),
    orgId: uuid("org_id").notNull(),
    storeId: uuid("store_id").notNull(),
    staffId: uuid("staff_id").notNull(),
    role: text("role").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: "staff_store_roles_pkey" }),
    uniqueIndex("staff_store_roles_tenant_id_uidx").on(table.orgId, table.storeId, table.id),
    uniqueIndex("staff_store_roles_staff_uidx").on(table.orgId, table.storeId, table.staffId),
    foreignKey({
      columns: [table.orgId, table.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: "staff_store_roles_store_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.staffId],
      foreignColumns: [staffs.orgId, staffs.id],
      name: "staff_store_roles_staff_fk",
    }),
  ],
);
