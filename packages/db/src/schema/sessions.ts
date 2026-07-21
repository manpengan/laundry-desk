import {
  foreignKey,
  integer,
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
 * Browser session records for A5/C6 (not in A3 matrix; store-scoped tenant columns).
 * status: active | revoked; session_version is monotonic per session.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").notNull(),
    orgId: uuid("org_id").notNull(),
    storeId: uuid("store_id").notNull(),
    staffId: uuid("staff_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    sessionVersion: integer("session_version").notNull().default(1),
    permissionVersion: integer("permission_version").notNull().default(1),
    authenticationMethod: text("authentication_method").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: "sessions_pkey" }),
    uniqueIndex("sessions_tenant_id_uidx").on(table.orgId, table.storeId, table.id),
    foreignKey({
      columns: [table.orgId, table.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: "sessions_store_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.staffId],
      foreignColumns: [staffs.orgId, staffs.id],
      name: "sessions_staff_fk",
    }),
  ],
);
