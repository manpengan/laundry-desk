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
 * Store-scope append-only audit trail (A3 matrix: store).
 * laundry_app is granted INSERT (+ SELECT for list queries) only — no UPDATE/DELETE/TRUNCATE.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").notNull(),
    orgId: uuid("org_id").notNull(),
    storeId: uuid("store_id").notNull(),
    staffId: uuid("staff_id"),
    via: text("via").notNull(),
    command: text("command").notNull(),
    idempotencyKey: text("idempotency_key"),
    dryRun: boolean("dry_run").notNull().default(false),
    entity: text("entity"),
    entityId: text("entity_id"),
    beforeJson: text("before_json"),
    afterJson: text("after_json"),
    ip: text("ip"),
    deviceId: uuid("device_id"),
    at: timestamp("at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: "audit_log_pkey" }),
    uniqueIndex("audit_log_tenant_id_uidx").on(table.orgId, table.storeId, table.id),
    uniqueIndex("audit_log_store_at_id_uidx").on(table.orgId, table.storeId, table.at, table.id),
    foreignKey({
      columns: [table.orgId, table.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: "audit_log_store_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.staffId],
      foreignColumns: [staffs.orgId, staffs.id],
      name: "audit_log_staff_fk",
    }),
  ],
);
