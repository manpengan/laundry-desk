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

import { orders } from "./orders.js";
import { staffs } from "./staffs.js";
import { stores } from "./stores.js";

/**
 * Store-scope append-only payment ledger (ADR-03).
 * laundry_app is granted SELECT, INSERT only — no UPDATE/DELETE.
 * Corrections use kind=reversal with ref_payment_id.
 */
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").notNull(),
    orgId: uuid("org_id").notNull(),
    storeId: uuid("store_id").notNull(),
    orderId: uuid("order_id").notNull(),
    method: text("method").notNull().default("cash"),
    amountCents: integer("amount_cents").notNull(),
    kind: text("kind").notNull(),
    refPaymentId: uuid("ref_payment_id"),
    staffId: uuid("staff_id").notNull(),
    at: timestamp("at", { withTimezone: true, mode: "date" }).notNull(),
    note: text("note"),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: "payments_pkey" }),
    uniqueIndex("payments_tenant_id_uidx").on(table.orgId, table.storeId, table.id),
    index("payments_order_at_idx").on(table.orgId, table.storeId, table.orderId, table.at),
    index("payments_store_at_idx").on(table.orgId, table.storeId, table.at),
    foreignKey({
      columns: [table.orgId, table.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: "payments_store_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.storeId, table.orderId],
      foreignColumns: [orders.orgId, orders.storeId, orders.id],
      name: "payments_order_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.staffId],
      foreignColumns: [staffs.orgId, staffs.id],
      name: "payments_staff_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.storeId, table.refPaymentId],
      foreignColumns: [table.orgId, table.storeId, table.id],
      name: "payments_ref_payment_fk",
    }),
  ],
);
