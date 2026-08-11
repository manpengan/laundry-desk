import {
  boolean,
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

import { customers } from "./customers.js";
import { staffs } from "./staffs.js";
import { stores } from "./stores.js";

/**
 * Store-scope counter orders (M2 skeleton).
 * Status: draft|open|closed|cancelled.
 * Money columns are integer cents; domain computes payable.
 */
export const orders = pgTable(
  "orders",
  {
    id: uuid("id").notNull(),
    orgId: uuid("org_id").notNull(),
    storeId: uuid("store_id").notNull(),
    ticketNo: text("ticket_no"),
    pickupCode: text("pickup_code"),
    status: text("status").notNull(),
    customerId: uuid("customer_id"),
    customerPhone: text("customer_phone"),
    customerName: text("customer_name"),
    note: text("note"),
    subtotalCents: integer("subtotal_cents").notNull(),
    originalCents: integer("original_cents").notNull().default(0),
    discountCents: integer("discount_cents").notNull().default(0),
    addonCents: integer("addon_cents").notNull().default(0),
    urgentCents: integer("urgent_cents").notNull().default(0),
    freightCents: integer("freight_cents").notNull().default(0),
    pricingPolicyVersion: integer("pricing_policy_version").notNull().default(0),
    urgentSelected: boolean("urgent_selected").notNull().default(false),
    freightSelected: boolean("freight_selected").notNull().default(false),
    payableCents: integer("payable_cents").notNull(),
    paidCents: integer("paid_cents").notNull(),
    balanceCents: integer("balance_cents").notNull(),
    businessDate: text("business_date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
    createdByStaffId: uuid("created_by_staff_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: "orders_pkey" }),
    uniqueIndex("orders_tenant_id_uidx").on(table.orgId, table.storeId, table.id),
    uniqueIndex("orders_ticket_no_uidx").on(table.orgId, table.storeId, table.ticketNo),
    uniqueIndex("orders_pickup_code_uidx").on(table.orgId, table.storeId, table.pickupCode),
    index("orders_store_status_created_idx").on(
      table.orgId,
      table.storeId,
      table.status,
      table.createdAt,
    ),
    index("orders_org_customer_created_idx").on(table.orgId, table.customerId, table.createdAt),
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
      columns: [table.orgId, table.customerId],
      foreignColumns: [customers.orgId, customers.id],
      name: "orders_customer_fk",
    }),
  ],
);
