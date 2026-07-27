import { index, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** Tenant-scoped durable command replay records (claimed and completed in one transaction). */
export const commandIdempotency = pgTable(
  "command_idempotency",
  {
    orgId: uuid("org_id").notNull(),
    storeId: uuid("store_id").notNull(),
    command: text("command").notNull(),
    idempotencyKey: uuid("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status").notNull().default("in_progress"),
    resultJson: jsonb("result_json"),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    primaryKey({
      columns: [table.orgId, table.storeId, table.command, table.idempotencyKey],
      name: "command_idempotency_pkey",
    }),
    index("command_idempotency_store_completed_idx").on(
      table.orgId,
      table.storeId,
      table.completedAt,
    ),
  ],
);
