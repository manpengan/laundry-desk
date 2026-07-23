import {
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { orgs } from "./orgs.js";

/**
 * Org-scope customer archive (A3 matrix: org).
 * One profile per phone per org; phone is mainland mobile seed-safe (13800000xxx).
 */
export const customers = pgTable(
  "customers",
  {
    id: uuid("id").notNull(),
    orgId: uuid("org_id").notNull(),
    phone: text("phone").notNull(),
    name: text("name"),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: "customers_pkey" }),
    uniqueIndex("customers_tenant_id_uidx").on(table.orgId, table.id),
    uniqueIndex("customers_org_phone_uidx").on(table.orgId, table.phone),
    index("customers_org_phone_idx").on(table.orgId, table.phone),
    index("customers_org_updated_idx").on(table.orgId, table.updatedAt),
    foreignKey({
      columns: [table.orgId],
      foreignColumns: [orgs.id],
      name: "customers_org_fk",
    }),
  ],
);
