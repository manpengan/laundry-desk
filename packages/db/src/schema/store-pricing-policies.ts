import {
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { staffs } from "./staffs.js";
import { stores } from "./stores.js";

/** Store-scoped authoritative fixed fees and per-piece add-on catalog (ADR-38). */
export const storePricingPolicies = pgTable(
  "store_pricing_policies",
  {
    orgId: uuid("org_id").notNull(),
    storeId: uuid("store_id").notNull(),
    urgentCents: integer("urgent_cents").notNull().default(0),
    freightCents: integer("freight_cents").notNull().default(0),
    addonsJson: jsonb("addons_json").notNull().default([]),
    version: integer("version").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedByStaffId: uuid("updated_by_staff_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.storeId], name: "store_pricing_policies_pkey" }),
    foreignKey({
      columns: [table.orgId, table.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: "store_pricing_policies_store_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.updatedByStaffId],
      foreignColumns: [staffs.orgId, staffs.id],
      name: "store_pricing_policies_staff_fk",
    }),
  ],
);
