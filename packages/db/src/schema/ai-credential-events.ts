import {
  foreignKey,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { aiCredentials } from "./ai-credentials.js";
import { staffs } from "./staffs.js";
import { stores } from "./stores.js";

/** Append-only metadata audit for credential setup and verification; never includes the key. */
export const aiCredentialEvents = pgTable(
  "ai_credential_events",
  {
    id: uuid("id").notNull(),
    orgId: uuid("org_id").notNull(),
    storeId: uuid("store_id").notNull(),
    credentialId: uuid("credential_id").notNull(),
    actorStaffId: uuid("actor_staff_id").notNull(),
    action: text("action").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: "ai_credential_events_pkey" }),
    uniqueIndex("ai_credential_events_tenant_id_uidx").on(table.orgId, table.storeId, table.id),
    foreignKey({
      columns: [table.orgId, table.credentialId],
      foreignColumns: [aiCredentials.orgId, aiCredentials.id],
      name: "ai_credential_events_credential_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: "ai_credential_events_store_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.actorStaffId],
      foreignColumns: [staffs.orgId, staffs.id],
      name: "ai_credential_events_staff_fk",
    }),
  ],
);
