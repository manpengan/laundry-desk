import {
  boolean,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { staffs } from "./staffs.js";
import { stores } from "./stores.js";

/** Current store-scoped delivery coverage, fee and appointment policy (ADR-46). */
export const deliveryPolicies = pgTable(
  "delivery_policies",
  {
    orgId: uuid("org_id").notNull(),
    storeId: uuid("store_id").notNull(),
    acceptingAppointments: boolean("accepting_appointments").notNull().default(false),
    minimumLeadMinutes: integer("minimum_lead_minutes").notNull().default(120),
    maximumAdvanceDays: integer("maximum_advance_days").notNull().default(14),
    slotMinutes: integer("slot_minutes").notNull().default(60),
    maxAppointmentsPerSlot: integer("max_appointments_per_slot").notNull().default(1),
    serviceAreasJson: jsonb("service_areas_json").notNull().default([]),
    weeklyWindowsJson: jsonb("weekly_windows_json").notNull().default([]),
    version: integer("version").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull(),
    updatedByStaffId: uuid("updated_by_staff_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.storeId], name: "delivery_policies_pkey" }),
    foreignKey({
      columns: [table.orgId, table.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: "delivery_policies_store_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.updatedByStaffId],
      foreignColumns: [staffs.orgId, staffs.id],
      name: "delivery_policies_staff_fk",
    }),
  ],
);
