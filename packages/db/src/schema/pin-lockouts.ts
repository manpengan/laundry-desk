import {
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { staffs } from "./staffs.js";
import { stores } from "./stores.js";

/**
 * Staff×device PIN lockout after brute-force exhaustion (A5: 15 minutes).
 * Natural key: (org_id, store_id, staff_id, device_id).
 */
export const pinLockouts = pgTable(
  "pin_lockouts",
  {
    id: uuid("id").notNull(),
    orgId: uuid("org_id").notNull(),
    storeId: uuid("store_id").notNull(),
    staffId: uuid("staff_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    lockedUntil: timestamp("locked_until", { withTimezone: true, mode: "date" }).notNull(),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: "pin_lockouts_pkey" }),
    uniqueIndex("pin_lockouts_tenant_id_uidx").on(table.orgId, table.storeId, table.id),
    uniqueIndex("pin_lockouts_staff_device_uidx").on(
      table.orgId,
      table.storeId,
      table.staffId,
      table.deviceId,
    ),
    foreignKey({
      columns: [table.orgId, table.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: "pin_lockouts_store_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.staffId],
      foreignColumns: [staffs.orgId, staffs.id],
      name: "pin_lockouts_staff_fk",
    }),
  ],
);
