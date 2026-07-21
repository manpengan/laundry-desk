import { pgTable, text, timestamp, uuid, uniqueIndex, primaryKey } from "drizzle-orm/pg-core";

import { orgs } from "./orgs.js";

/** Org-scope store directory (A3 matrix: org). UNIQUE(org_id, id) for store FKs. */
export const stores = pgTable(
  "stores",
  {
    id: uuid("id").notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    code: text("code").notNull(),
    name: text("name").notNull(),
    timezone: text("timezone").notNull().default("Asia/Shanghai"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: "stores_pkey" }),
    uniqueIndex("stores_org_id_uidx").on(table.orgId, table.id),
    uniqueIndex("stores_org_code_uidx").on(table.orgId, table.code),
  ],
);
