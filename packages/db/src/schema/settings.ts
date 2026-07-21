import {
  foreignKey,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { orgs } from "./orgs.js";
import { staffs } from "./staffs.js";

/**
 * Org-scope settings key/value store (A3 matrix: org).
 * value_json is a JSON string (A6 platform.settings.*); never float money.
 */
export const settings = pgTable(
  "settings",
  {
    id: uuid("id").notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    key: text("key").notNull(),
    valueJson: text("value_json").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedByStaffId: uuid("updated_by_staff_id"),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: "settings_pkey" }),
    uniqueIndex("settings_org_id_uidx").on(table.orgId, table.id),
    uniqueIndex("settings_org_key_uidx").on(table.orgId, table.key),
    foreignKey({
      columns: [table.orgId, table.updatedByStaffId],
      foreignColumns: [staffs.orgId, staffs.id],
      name: "settings_updated_by_staff_fk",
    }),
  ],
);
