import { foreignKey, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { customers } from "./customers.js";
import { staffs } from "./staffs.js";
import { stores } from "./stores.js";

/** Store-scoped appointment and capacity-hold projection (ADR-47). */
export const deliveryAppointments = pgTable(
  "delivery_appointments",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    storeId: uuid("store_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    addressId: uuid("address_id").notNull(),
    direction: text("direction").notNull(),
    serviceAreaCode: text("service_area_code").notNull(),
    scheduledStartAt: timestamp("scheduled_start_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    scheduledEndAt: timestamp("scheduled_end_at", { withTimezone: true, mode: "date" }).notNull(),
    feeCents: integer("fee_cents").notNull(),
    status: text("status").notNull().default("scheduled"),
    version: integer("version").notNull().default(1),
    policyVersion: integer("policy_version").notNull(),
    cancellationReason: text("cancellation_reason"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
    createdByStaffId: uuid("created_by_staff_id").notNull(),
    updatedByStaffId: uuid("updated_by_staff_id").notNull(),
    cancelledByStaffId: uuid("cancelled_by_staff_id"),
  },
  (table) => [
    unique("delivery_appointments_tenant_id_uidx").on(table.orgId, table.storeId, table.id),
    foreignKey({
      columns: [table.orgId, table.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: "delivery_appointments_store_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.customerId],
      foreignColumns: [customers.orgId, customers.id],
      name: "delivery_appointments_customer_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.createdByStaffId],
      foreignColumns: [staffs.orgId, staffs.id],
      name: "delivery_appointments_created_staff_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.updatedByStaffId],
      foreignColumns: [staffs.orgId, staffs.id],
      name: "delivery_appointments_updated_staff_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.cancelledByStaffId],
      foreignColumns: [staffs.orgId, staffs.id],
      name: "delivery_appointments_cancelled_staff_fk",
    }),
  ],
);
