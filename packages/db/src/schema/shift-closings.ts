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

import { staffs } from "./staffs.js";
import { stores } from "./stores.js";

/**
 * Store-scope append-only shift closing / 日结签字 (M2 skeleton).
 * laundry_app is granted SELECT, INSERT only — no UPDATE/DELETE.
 * One close per (org, store, business_date).
 */
export const shiftClosings = pgTable(
  "shift_closings",
  {
    id: uuid("id").notNull(),
    orgId: uuid("org_id").notNull(),
    storeId: uuid("store_id").notNull(),
    businessDate: text("business_date").notNull(),
    closedByStaffId: uuid("closed_by_staff_id").notNull(),
    note: text("note"),
    orderCount: integer("order_count").notNull().default(0),
    payableCents: integer("payable_cents").notNull().default(0),
    paidCents: integer("paid_cents").notNull().default(0),
    paymentCents: integer("payment_cents").notNull().default(0),
    signatureName: text("signature_name").notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: "shift_closings_pkey" }),
    uniqueIndex("shift_closings_tenant_id_uidx").on(table.orgId, table.storeId, table.id),
    uniqueIndex("shift_closings_store_date_uidx").on(
      table.orgId,
      table.storeId,
      table.businessDate,
    ),
    index("shift_closings_store_closed_at_idx").on(table.orgId, table.storeId, table.closedAt),
    foreignKey({
      columns: [table.orgId, table.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: "shift_closings_store_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.closedByStaffId],
      foreignColumns: [staffs.orgId, staffs.id],
      name: "shift_closings_staff_fk",
    }),
  ],
);
