import { foreignKey, integer, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";

import { stores } from "./stores.js";

/**
 * Per-store daily ticket sequence helper for nextTicketSeq (online YYYYMMDD-NNNN).
 * Not in A3 matrix; store-scoped RLS like other operational helpers.
 */
export const ticketCounters = pgTable(
  "ticket_counters",
  {
    orgId: uuid("org_id").notNull(),
    storeId: uuid("store_id").notNull(),
    dayKey: text("day_key").notNull(),
    lastSeq: integer("last_seq").notNull().default(0),
  },
  (table) => [
    primaryKey({
      columns: [table.orgId, table.storeId, table.dayKey],
      name: "ticket_counters_pkey",
    }),
    foreignKey({
      columns: [table.orgId, table.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: "ticket_counters_store_fk",
    }),
  ],
);
