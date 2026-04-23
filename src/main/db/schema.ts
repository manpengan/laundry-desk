import { relations, sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const customers = sqliteTable("customers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  phone: text("phone").notNull().unique(),
  vipLevel: integer("vip_level").default(0).notNull(),
  totalOrders: integer("total_orders").default(0).notNull(),
  totalSpent: integer("total_spent").default(0).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).default(
    sql`(strftime('%s', 'now'))`,
  ),
  updatedAt: integer("updated_at", { mode: "timestamp" }).default(
    sql`(strftime('%s', 'now'))`,
  ),
});

export const staffs = sqliteTable("staffs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  role: text("role", { enum: ["admin", "staff"] })
    .default("staff")
    .notNull(),
  isActive: integer("is_active", { mode: "boolean" }).default(true).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).default(
    sql`(strftime('%s', 'now'))`,
  ),
  lastLoginAt: integer("last_login_at", { mode: "timestamp" }),
});

export const orders = sqliteTable(
  "orders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderNo: text("order_no").notNull().unique(),
    pickupCode: text("pickup_code", { length: 4 }).notNull(),
    customerId: integer("customer_id")
      .notNull()
      .references(() => customers.id),
    status: text("status", {
      enum: ["pending", "ready", "picked_up", "cancelled"],
    })
      .default("pending")
      .notNull(),
    totalAmount: integer("total_amount").notNull(),
    paidAmount: integer("paid_amount").default(0).notNull(),
    paymentMethod: text("payment_method", {
      enum: ["cash", "wechat", "alipay", "card", "unpaid"],
    }).notNull(),
    receiveDate: integer("receive_date", { mode: "timestamp" })
      .default(sql`(strftime('%s', 'now'))`)
      .notNull(),
    expectedPickupDate: integer("expected_pickup_date", { mode: "timestamp" }),
    actualPickupAt: integer("actual_pickup_at", { mode: "timestamp" }),
    staffId: integer("staff_id").references(() => staffs.id),
    pickedUpBy: integer("picked_up_by").references(() => staffs.id),
    notes: text("notes"),
    createdAt: integer("created_at", { mode: "timestamp" }).default(
      sql`(strftime('%s', 'now'))`,
    ),
    updatedAt: integer("updated_at", { mode: "timestamp" }).default(
      sql`(strftime('%s', 'now'))`,
    ),
  },
  (table) => ({
    pickupCodeIdx: index("orders_pickup_code_idx").on(table.pickupCode),
    customerStatusDateIdx: index("orders_customer_status_date_idx").on(
      table.customerId,
      table.status,
      table.receiveDate,
    ),
  }),
);

export const orderItems = sqliteTable("order_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: integer("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  itemType: text("item_type").notNull(),
  serviceType: text("service_type", {
    enum: ["wash", "dry_clean", "iron"],
  }).notNull(),
  quantity: integer("quantity").notNull(),
  unitPrice: integer("unit_price").notNull(),
  subtotal: integer("subtotal").notNull(),
  itemNotes: text("item_notes"),
});

export const orderPhotos = sqliteTable("order_photos", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: integer("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  filePath: text("file_path").notNull(),
  takenAt: integer("taken_at", { mode: "timestamp" }).default(
    sql`(strftime('%s', 'now'))`,
  ),
});

export const smsLog = sqliteTable("sms_log", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderId: integer("order_id").references(() => orders.id),
  phone: text("phone").notNull(),
  content: text("content").notNull(),
  status: text("status", { enum: ["pending", "sent", "failed"] })
    .default("pending")
    .notNull(),
  providerResponse: text("provider_response"),
  sentAt: integer("sent_at", { mode: "timestamp" }),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).default(
    sql`(strftime('%s', 'now'))`,
  ),
});

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    staffId: integer("staff_id").references(() => staffs.id),
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: integer("entity_id"),
    diff: text("diff"),
    createdAt: integer("created_at", { mode: "timestamp" }).default(
      sql`(strftime('%s', 'now'))`,
    ),
  },
  (table) => ({
    createdAtIdx: index("audit_log_created_at_idx").on(table.createdAt),
  }),
);

export const customersRelations = relations(customers, ({ many }) => ({
  orders: many(orders),
}));

export const staffsRelations = relations(staffs, ({ many }) => ({
  createdOrders: many(orders, { relationName: "createdOrders" }),
  pickedOrders: many(orders, { relationName: "pickedOrders" }),
  auditLogs: many(auditLog),
}));

export const ordersRelations = relations(orders, ({ one, many }) => ({
  customer: one(customers, {
    fields: [orders.customerId],
    references: [customers.id],
  }),
  staff: one(staffs, {
    fields: [orders.staffId],
    references: [staffs.id],
    relationName: "createdOrders",
  }),
  pickedUpStaff: one(staffs, {
    fields: [orders.pickedUpBy],
    references: [staffs.id],
    relationName: "pickedOrders",
  }),
  items: many(orderItems),
  photos: many(orderPhotos),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, {
    fields: [orderItems.orderId],
    references: [orders.id],
  }),
}));

export const orderPhotosRelations = relations(orderPhotos, ({ one }) => ({
  order: one(orders, {
    fields: [orderPhotos.orderId],
    references: [orders.id],
  }),
}));

export const auditLogRelations = relations(auditLog, ({ one }) => ({
  staff: one(staffs, {
    fields: [auditLog.staffId],
    references: [staffs.id],
  }),
}));
