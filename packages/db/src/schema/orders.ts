import {
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { staffs } from "./staffs.js";
import { stores } from "./stores.js";

/**
 * Store-scope counter orders (M2 skeleton).
 * Status: open|closed|cancelled (no draft in skeleton).
 * Money columns are integer cents; domain computes payable.
 */
export const orders = pgTable(
  "orders",
  {
    id: uuid("id").notNull(),
    orgId: uuid("org_id").notNull(),
    storeId: uuid("store_id").notNull(),
    ticketNo: text("ticket_no").notNull(),
    status: text("status").notNull(),
    customerPhone: text("customer_phone"),
    customerName: text("customer_name"),
    note: text("note"),
    holdReason: text("hold_reason"),
    heldAt: timestamp("held_at", { withTimezone: true, mode: "date" }),
    heldByStaffId: uuid("held_by_staff_id"),
    subtotalCents: integer("subtotal_cents").notNull(),
    payableCents: integer("payable_cents").notNull(),
    paidCents: integer("paid_cents").notNull(),
    balanceCents: integer("balance_cents").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
    createdByStaffId: uuid("created_by_staff_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: "orders_pkey" }),
    uniqueIndex("orders_tenant_id_uidx").on(table.orgId, table.storeId, table.id),
    uniqueIndex("orders_ticket_no_uidx").on(table.orgId, table.storeId, table.ticketNo),
    index("orders_store_status_created_idx").on(
      table.orgId,
      table.storeId,
      table.status,
      table.createdAt,
    ),
    index("orders_store_hold_created_idx")
      .on(table.orgId, table.storeId, table.createdAt)
      .where(sql`${table.holdReason} IS NOT NULL`),
    foreignKey({
      columns: [table.orgId, table.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: "orders_store_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.createdByStaffId],
      foreignColumns: [staffs.orgId, staffs.id],
      name: "orders_created_by_staff_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.heldByStaffId],
      foreignColumns: [staffs.orgId, staffs.id],
      name: "orders_held_by_staff_fk",
    }),
  ],
);
