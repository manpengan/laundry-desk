import {
  foreignKey,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { sessions } from "./sessions.js";
import { stores } from "./stores.js";

/**
 * Single-use PIN challenges for quick-switch / step-up (A5).
 * status: open | consumed | expired | exhausted.
 * step_up binds args_hash / entity_versions / idempotency_key (WYSIWYS).
 */
export const pinChallenges = pgTable(
  "pin_challenges",
  {
    id: uuid("id").notNull(),
    orgId: uuid("org_id").notNull(),
    storeId: uuid("store_id").notNull(),
    deviceId: uuid("device_id").notNull(),
    sessionId: uuid("session_id").notNull(),
    sessionVersion: integer("session_version").notNull(),
    purpose: text("purpose").notNull(),
    targetStaffId: uuid("target_staff_id"),
    approverStaffId: uuid("approver_staff_id"),
    pendingActionRef: text("pending_action_ref"),
    argsHash: text("args_hash"),
    entityVersions: jsonb("entity_versions").notNull().default([]),
    idempotencyKey: uuid("idempotency_key"),
    nonce: text("nonce").notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    status: text("status").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true, mode: "date" }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [
    primaryKey({ columns: [table.id], name: "pin_challenges_pkey" }),
    uniqueIndex("pin_challenges_tenant_id_uidx").on(table.orgId, table.storeId, table.id),
    foreignKey({
      columns: [table.orgId, table.storeId],
      foreignColumns: [stores.orgId, stores.id],
      name: "pin_challenges_store_fk",
    }),
    foreignKey({
      columns: [table.sessionId],
      foreignColumns: [sessions.id],
      name: "pin_challenges_session_fk",
    }),
  ],
);
