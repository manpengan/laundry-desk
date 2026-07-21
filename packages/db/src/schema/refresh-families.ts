import {
  foreignKey,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { sessions } from "./sessions.js";
import { stores } from "./stores.js";

/** Refresh token family binding a session (A5). status: active | revoked. */
export const refreshFamilies = pgTable(
  "refresh_families",
  {
    id: uuid("id").notNull(),
    sessionId: uuid("session_id").notNull(),
    orgId: uuid("org_id").notNull(),
    storeId: uuid("store_id").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: "refresh_families_pkey" }),
    uniqueIndex("refresh_families_tenant_id_uidx").on(table.orgId, table.storeId, table.id),
    foreignKey({
      columns: [table.orgId, table.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: "refresh_families_store_fk",
    }),
    foreignKey({
      columns: [table.sessionId],
      foreignColumns: [sessions.id],
      name: "refresh_families_session_fk",
    }),
  ],
);
