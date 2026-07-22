import {
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { stores } from "./stores.js";

/**
 * Store-scope print job queue (M2).
 * Soft-binds order_id (no orders FK — avoids seed / offline race pain).
 * payload_bytes is ESC/POS length after successful process (xp58).
 */
export const printJobs = pgTable(
  "print_jobs",
  {
    id: uuid("id").notNull(),
    orgId: uuid("org_id").notNull(),
    storeId: uuid("store_id").notNull(),
    orderId: uuid("order_id").notNull(),
    ticketNo: text("ticket_no").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    error: text("error"),
    payloadBytes: integer("payload_bytes"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: "print_jobs_pkey" }),
    uniqueIndex("print_jobs_tenant_id_uidx").on(table.orgId, table.storeId, table.id),
    index("print_jobs_store_created_idx").on(table.orgId, table.storeId, table.createdAt),
    index("print_jobs_store_status_idx").on(table.orgId, table.storeId, table.status),
    foreignKey({
      columns: [table.orgId, table.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: "print_jobs_store_fk",
    }),
  ],
);
