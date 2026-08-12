import { foreignKey, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { customers } from "./customers.js";
import { deliveryAppointments } from "./delivery-appointments.js";
import { orders } from "./orders.js";
import { staffs } from "./staffs.js";
import { stores } from "./stores.js";

/** Store-scoped authoritative logistics lifecycle (ADR-48). */
export const deliveryOrders = pgTable(
  "delivery_orders",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    storeId: uuid("store_id").notNull(),
    laundryOrderId: uuid("laundry_order_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    collectionMethod: text("collection_method").notNull(),
    returnMethod: text("return_method").notNull(),
    pickupAppointmentId: uuid("pickup_appointment_id"),
    returnAppointmentId: uuid("return_appointment_id"),
    pickupFeeCents: integer("pickup_fee_cents").notNull().default(0),
    returnFeeCents: integer("return_fee_cents").notNull().default(0),
    totalFeeCents: integer("total_fee_cents").notNull().default(0),
    status: text("status").notNull(),
    version: integer("version").notNull().default(1),
    cancellationReason: text("cancellation_reason"),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
    createdByStaffId: uuid("created_by_staff_id").notNull(),
    updatedByStaffId: uuid("updated_by_staff_id").notNull(),
  },
  (table) => [
    unique("delivery_orders_tenant_id_uidx").on(table.orgId, table.storeId, table.id),
    foreignKey({
      columns: [table.orgId, table.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: "delivery_orders_store_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.storeId, table.laundryOrderId],
      foreignColumns: [orders.orgId, orders.storeId, orders.id],
      name: "delivery_orders_laundry_order_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.customerId],
      foreignColumns: [customers.orgId, customers.id],
      name: "delivery_orders_customer_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.storeId, table.pickupAppointmentId],
      foreignColumns: [
        deliveryAppointments.orgId,
        deliveryAppointments.storeId,
        deliveryAppointments.id,
      ],
      name: "delivery_orders_pickup_appointment_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.storeId, table.returnAppointmentId],
      foreignColumns: [
        deliveryAppointments.orgId,
        deliveryAppointments.storeId,
        deliveryAppointments.id,
      ],
      name: "delivery_orders_return_appointment_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.createdByStaffId],
      foreignColumns: [staffs.orgId, staffs.id],
      name: "delivery_orders_created_staff_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.updatedByStaffId],
      foreignColumns: [staffs.orgId, staffs.id],
      name: "delivery_orders_updated_staff_fk",
    }),
  ],
);
