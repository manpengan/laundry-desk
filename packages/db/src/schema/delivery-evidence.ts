import {
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { deliveryOrders } from "./delivery-orders.js";
import { deliveryTasks } from "./delivery-tasks.js";
import { staffs } from "./staffs.js";
import { stores } from "./stores.js";

const authorityColumns = {
  orgId: uuid("org_id").notNull(),
  storeId: uuid("store_id").notNull(),
  deliveryOrderId: uuid("delivery_order_id").notNull(),
  deliveryTaskId: uuid("delivery_task_id").notNull(),
  leg: text("leg").notNull(),
  deliveryTaskVersion: integer("delivery_task_version").notNull(),
  assigneeStaffId: uuid("assignee_staff_id").notNull(),
};

export const deliveryEvidenceAttachments = pgTable(
  "delivery_evidence_attachments",
  {
    id: uuid("id").primaryKey(),
    ...authorityColumns,
    kind: text("kind").notNull(),
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull(),
    contentSha256: text("content_sha256").notNull(),
    byteSize: integer("byte_size").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true, mode: "date" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull(),
    createdByStaffId: uuid("created_by_staff_id").notNull(),
  },
  (table) => [
    unique("delivery_evidence_attachments_tenant_id_uidx").on(table.orgId, table.storeId, table.id),
    unique("delivery_evidence_attachments_storage_uidx").on(
      table.orgId,
      table.storeId,
      table.storageKey,
    ),
    foreignKey({
      columns: [table.orgId, table.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: "delivery_evidence_attachments_store_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.storeId, table.deliveryOrderId],
      foreignColumns: [deliveryOrders.orgId, deliveryOrders.storeId, deliveryOrders.id],
      name: "delivery_evidence_attachments_order_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.storeId, table.deliveryTaskId],
      foreignColumns: [deliveryTasks.orgId, deliveryTasks.storeId, deliveryTasks.id],
      name: "delivery_evidence_attachments_task_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.createdByStaffId],
      foreignColumns: [staffs.orgId, staffs.id],
      name: "delivery_evidence_attachments_staff_fk",
    }),
  ],
);

export const deliveryEvidenceEvents = pgTable(
  "delivery_evidence_events",
  {
    id: uuid("id").primaryKey(),
    ...authorityColumns,
    eventKind: text("event_kind").notNull(),
    outcome: text("outcome").notNull(),
    exceptionReason: text("exception_reason"),
    capturedAt: timestamp("captured_at", { withTimezone: true, mode: "date" }).notNull(),
    latitudeE7: integer("latitude_e7"),
    longitudeE7: integer("longitude_e7"),
    accuracyMm: integer("accuracy_mm"),
    gpsCapturedAt: timestamp("gps_captured_at", { withTimezone: true, mode: "date" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "date" }).notNull(),
    recordedByStaffId: uuid("recorded_by_staff_id").notNull(),
  },
  (table) => [
    unique("delivery_evidence_events_tenant_id_uidx").on(table.orgId, table.storeId, table.id),
    foreignKey({
      columns: [table.orgId, table.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: "delivery_evidence_events_store_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.storeId, table.deliveryOrderId],
      foreignColumns: [deliveryOrders.orgId, deliveryOrders.storeId, deliveryOrders.id],
      name: "delivery_evidence_events_order_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.storeId, table.deliveryTaskId],
      foreignColumns: [deliveryTasks.orgId, deliveryTasks.storeId, deliveryTasks.id],
      name: "delivery_evidence_events_task_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.recordedByStaffId],
      foreignColumns: [staffs.orgId, staffs.id],
      name: "delivery_evidence_events_staff_fk",
    }),
  ],
);

export const deliveryEvidenceAttachmentLinks = pgTable(
  "delivery_evidence_attachment_links",
  {
    orgId: uuid("org_id").notNull(),
    storeId: uuid("store_id").notNull(),
    deliveryEvidenceId: uuid("delivery_evidence_id").notNull(),
    attachmentId: uuid("attachment_id").notNull(),
    linkedAt: timestamp("linked_at", { withTimezone: true, mode: "date" }).notNull(),
    linkedByStaffId: uuid("linked_by_staff_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.orgId, table.storeId, table.deliveryEvidenceId, table.attachmentId],
      name: "delivery_evidence_attachment_links_pkey",
    }),
    unique("delivery_evidence_attachment_links_attachment_uidx").on(
      table.orgId,
      table.storeId,
      table.attachmentId,
    ),
    foreignKey({
      columns: [table.orgId, table.storeId, table.deliveryEvidenceId],
      foreignColumns: [
        deliveryEvidenceEvents.orgId,
        deliveryEvidenceEvents.storeId,
        deliveryEvidenceEvents.id,
      ],
      name: "delivery_evidence_attachment_links_evidence_fk",
    }),
    foreignKey({
      columns: [table.orgId, table.storeId, table.attachmentId],
      foreignColumns: [
        deliveryEvidenceAttachments.orgId,
        deliveryEvidenceAttachments.storeId,
        deliveryEvidenceAttachments.id,
      ],
      name: "delivery_evidence_attachment_links_attachment_fk",
    }),
  ],
);
