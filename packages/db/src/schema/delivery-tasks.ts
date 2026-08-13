import { foreignKey, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { deliveryOrders } from "./delivery-orders.js";
import { staffStoreRoles } from "./staff-store-roles.js";
import { staffs } from "./staffs.js";
import { stores } from "./stores.js";

/** Store-scoped task assignment and succession history (ADR-49). */
export const deliveryTasks = pgTable(
  "delivery_tasks",
  {
    id: uuid("id").primaryKey(),
    orgId: uuid("org_id").notNull(),
    storeId: uuid("store_id").notNull(),
    deliveryOrderId: uuid("delivery_order_id").notNull(),
    leg: text("leg").notNull(),
    assigneeStaffId: uuid("assignee_staff_id").notNull(),
    assignedByStaffId: uuid("assigned_by_staff_id").notNull(),
    predecessorTaskId: uuid("predecessor_task_id"),
    source: text("source").notNull(),
    status: text("status").notNull(),
    version: integer("version").notNull().default(1),
    resolutionReason: text("resolution_reason"),
    acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "date" }),
    rejectedAt: timestamp("rejected_at", { withTimezone: true, mode: "date" }),
    transferredAt: timestamp("transferred_at", { withTimezone: true, mode: "date" }),
    takenOverAt: timestamp("taken_over_at", { withTimezone: true, mode: "date" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
    createdByStaffId: uuid("created_by_staff_id").notNull(),
    updatedByStaffId: uuid("updated_by_staff_id").notNull(),
  },
  (table) => [
    unique("delivery_tasks_tenant_id_uidx").on(table.orgId, table.storeId, table.id),
    foreignKey({
      columns: [table.orgId, table.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: "delivery_tasks_store_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.storeId, table.deliveryOrderId],
      foreignColumns: [deliveryOrders.orgId, deliveryOrders.storeId, deliveryOrders.id],
      name: "delivery_tasks_order_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.storeId, table.assigneeStaffId],
      foreignColumns: [staffStoreRoles.orgId, staffStoreRoles.storeId, staffStoreRoles.staffId],
      name: "delivery_tasks_assignee_role_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.assignedByStaffId],
      foreignColumns: [staffs.orgId, staffs.id],
      name: "delivery_tasks_assigned_by_staff_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.storeId, table.predecessorTaskId],
      foreignColumns: [table.orgId, table.storeId, table.id],
      name: "delivery_tasks_predecessor_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.createdByStaffId],
      foreignColumns: [staffs.orgId, staffs.id],
      name: "delivery_tasks_created_staff_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.updatedByStaffId],
      foreignColumns: [staffs.orgId, staffs.id],
      name: "delivery_tasks_updated_staff_fk",
    }),
  ],
);
