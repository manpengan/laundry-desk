import {
  boolean,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { orgs } from "./orgs.js";

/** Org-scope staff accounts (A3 matrix: org). Password/PIN are argon2id hashes only. */
export const staffs = pgTable(
  "staffs",
  {
    id: uuid("id").notNull(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    pinHash: text("pin_hash"),
    displayName: text("display_name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    permissionVersion: integer("permission_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: "staffs_pkey" }),
    uniqueIndex("staffs_org_id_uidx").on(table.orgId, table.id),
    uniqueIndex("staffs_org_username_uidx").on(table.orgId, table.username),
  ],
);
